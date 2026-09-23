import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { fetch as expoFetch } from 'expo/fetch';
import type { SQLiteDatabase } from 'expo-sqlite';
import { acquireSyncLease, applySyncApplication, captureLocalChanges, getSyncSettings, pauseSync, releaseSyncLease, saveSyncConfiguration } from '../data/sync-repository';
import { createWebDavTransport, synchronize, SyncError } from './core';
import { readSyncBlob, sha256, syncAssets } from './assets';
import { basicAuthorization } from './authorization';

const CREDENTIAL_KEY = 'lumen-webdav-credentials-v1';
// The protocol passes string URLs, plain headers and ArrayBuffer bodies only;
// Expo provides the standard response methods it consumes, but omits Request input overloads.
const webDavFetch = expoFetch as unknown as typeof globalThis.fetch;
let active: Promise<void> | null = null;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();
export function onSyncUpdate(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function notify() { for (const listener of listeners) listener(); }

export async function enableSync(db: SQLiteDatabase, input: { endpoint: string; libraryId: string; username: string; password: string; consent: boolean }) {
  if (active) throw new Error('同步正在完成，请稍后更改设置');
  if (!input.username.trim() || !input.password) throw new Error('请填写 WebDAV 用户名与应用密码');
  if (input.username.includes(':')) throw new Error('WebDAV 用户名不能包含冒号');
  if (!input.consent || !/^[A-Za-z0-9_-]{1,96}$/.test(input.libraryId)) throw new Error('请确认资料库名称和同步授权');
  // Verify the user-entered location before binding this device permanently to a history.
  try {
    // Expo's native fetch honors manual redirects; RN's XHR-backed global fetch does not.
    const transport = createWebDavTransport({ endpoint: input.endpoint, authorization: basicAuthorization(input.username, input.password), fetch: webDavFetch });
    await transport.ensureDirectories(['lumen-sync-v1/']);
    await transport.list('lumen-sync-v1/');
  } catch (error) { throw new Error(syncErrorMessage(error)); }
  // Configuration validation happens before storing credentials. Disable until both stores are durable.
  await saveSyncConfiguration(db, { ...input, deviceId: Crypto.randomUUID().replaceAll('-', '') });
  await pauseSync(db);
  await SecureStore.setItemAsync(CREDENTIAL_KEY, JSON.stringify({ username: input.username, password: input.password }), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  await db.runAsync("UPDATE sync_settings SET enabled=1,status='pending',last_error=NULL WHERE id=1");
  notify();
}

export async function disableSync(db: SQLiteDatabase) {
  await pauseSync(db);
  controller?.abort();
  if (active) await active.catch(() => undefined);
  notify();
}

function syncErrorMessage(error: unknown) {
  if (error instanceof SyncError) {
    if (/-(401|403)$/.test(error.code)) return 'WebDAV 验证或文件夹权限失败，请检查用户名、应用密码与读写权限';
    if (/-(404|409)$/.test(error.code)) return 'WebDAV 文件夹不存在，请先在服务端建立文件夹并核对地址';
    if (error.code === 'redirect-rejected') return 'WebDAV 地址发生重定向；请使用服务提供的最终 HTTPS 文件地址';
    if (/network|cancelled/.test(error.code)) return '网络暂不可用或同步超时，离线修改已保留，稍后会重试';
    if (/limit/.test(error.code)) return '同步内容超过当前单次容量限制；原始内容和待同步队列已保留，请先缩小本次内容范围';
    if (/integrity|mismatch|collision/.test(error.code)) return '同步内容校验不一致，已停止应用并保留本机数据，请检查服务端文件是否被外部修改';
    return '服务端同步格式不兼容或内容不完整，已保留本机数据；请检查各设备版本和 WebDAV 支持';
  }
  const message = error instanceof Error ? error.message : '';
  return /^(同步|附件|原始附件|此设备|请先|资料库|WebDAV)/.test(message) && message.length < 400
    ? message.replace(/https?:\/\/\S+/g, '[服务地址]') : '同步未完成；请检查连接、WebDAV 权限和资料完整性后重试';
}

export function runSync(db: SQLiteDatabase, force = false): Promise<void> {
  if (active) return active;
  active = (async () => {
    const settings = await getSyncSettings(db);
    if (!settings?.enabled || !settings.consented_at) return;
    if (!force && settings.last_attempt_at && Date.now() - Date.parse(settings.last_attempt_at) < 30_000) return;
    const leaseOwner = Crypto.randomUUID();
    if (!await acquireSyncLease(db, leaseOwner)) return;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 120_000);
    try {
      await db.runAsync("UPDATE sync_settings SET status='running',last_attempt_at=?,last_error=NULL WHERE id=1", new Date().toISOString());
      notify();
      const raw = await SecureStore.getItemAsync(CREDENTIAL_KEY);
      if (!raw) throw new Error('同步凭据不可用，请重新填写 WebDAV 应用密码');
      const credentials = JSON.parse(raw) as { username: string; password: string };
      const state = await captureLocalChanges(db, sha256, syncAssets);
      const transport = createWebDavTransport({ endpoint: settings.endpoint, authorization: basicAuthorization(credentials.username, credentials.password), fetch: webDavFetch });
      const result = await synchronize({ state, transport, sha256, readBlob: readSyncBlob, signal: controller.signal,
        apply: async (application) => {
          if (!(await getSyncSettings(db))?.enabled) throw new Error('同步已暂停');
          await applySyncApplication(db, application, syncAssets);
        } });
      const dirty = await db.getFirstAsync('SELECT 1 FROM sync_changes LIMIT 1');
      await db.runAsync('UPDATE sync_settings SET status=?,last_success_at=?,last_error=? WHERE id=1 AND enabled=1', result.pending.length || dirty ? 'pending' : 'synced', new Date().toISOString(), result.pending.length ? '部分更改等待其依赖内容；下一轮将自动重试' : null);
    } catch (error) {
      // Do not persist request headers, credentials or response bodies in status/errors.
      await db.runAsync("UPDATE sync_settings SET status='failed',last_error=? WHERE id=1 AND enabled=1", syncErrorMessage(error));
    } finally {
      clearTimeout(timeout);
      controller = null;
      await releaseSyncLease(db, leaseOwner);
      notify();
    }
  })().finally(() => { active = null; });
  return active;
}
