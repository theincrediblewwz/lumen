import { useCallback, useEffect, useState } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { getSyncSettings, keepLocalBlockedSync, listBlockedSync, listSyncConflicts, resolveSyncConflict, type BlockedSync, type SyncSettings } from '../data/sync-repository';
import { refreshBackgroundSync } from '../sync/background';
import { sha256, syncAssets } from '../sync/assets';
import { disableSync, enableSync, onSyncUpdate, runSync } from '../sync/runtime';
import type { SyncConflict } from '../sync/core';
import { colors, radii } from '../theme/tokens';

const statusText: Record<string, string> = { paused: '同步已暂停', pending: '等待同步', running: '正在同步', synced: '已同步', failed: '等待重试' };

export default function SyncSettingsScreen() {
  const db = useSQLiteContext();
  const [settings, setSettings] = useState<SyncSettings | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [libraryId, setLibraryId] = useState('my-learning');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [blocked, setBlocked] = useState<BlockedSync[]>([]);
  const [expandedRecord, setExpandedRecord] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key: string; revision: string; body: string } | null>(null);
  const refresh = useCallback(async () => {
    const [next, versions, pending] = await Promise.all([getSyncSettings(db), listSyncConflicts(db), listBlockedSync(db)]);
    setSettings(next); setConflicts(versions); setBlocked(pending);
  }, [db]);
  useEffect(() => {
    let alive = true;
    void getSyncSettings(db).then((value) => {
      if (!alive || !value) return;
      setEndpoint(value.endpoint); setLibraryId(value.library_id); setConsent(Boolean(value.consented_at));
    });
    void refresh();
    const unsubscribe = onSyncUpdate(() => { if (alive) void refresh(); });
    return () => { alive = false; unsubscribe(); };
  }, [db, refresh]);

  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await action(); await refresh(); }
    catch (error) { Alert.alert('同步尚未完成', error instanceof Error ? error.message : '请稍后重试'); }
    finally { setBusy(false); }
  };
  const save = () => perform(async () => {
    await enableSync(db, { endpoint, libraryId, username, password, consent });
    setPassword('');
    await refreshBackgroundSync(db);
    await runSync(db, true);
  });
  const resolve = (conflict: SyncConflict, revision: string, body?: string) => {
    Alert.alert('使用这个版本？', '其他版本仍保存在同步历史中。确认后，选择或合并的内容将同步到所有设备。', [
      { text: '取消', style: 'cancel' },
      { text: body === undefined ? '使用此版本' : '保存合并', onPress: () => { void perform(async () => {
        await resolveSyncConflict(db, conflict.key, revision, body, sha256, syncAssets);
        setEditing(null); await runSync(db, true);
      }); } },
    ]);
  };
  const keepLocal = (record: BlockedSync) => {
    Alert.alert('保留本机内容并继续同步？', `这条远端记录涉及 ${record.commit.changes.length} 项改动。其删除、编辑和其他改动均以本机现状为准，并同步到其他设备。完整远端版本仍保存在历史中，可在此查看和导出。其他同步记录不受影响。`, [
      { text: '取消', style: 'cancel' }, { text: '保留本机并继续', onPress: () => { void perform(async () => {
        await keepLocalBlockedSync(db, record.id, sha256); await runSync(db, true);
      }); } },
    ]);
  };
  const exportRecord = (record: BlockedSync) => perform(async () => {
    const files = await import('expo-file-system/legacy');
    const permission = await files.StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!permission.granted) return;
    const uri = await files.StorageAccessFramework.createFileAsync(permission.directoryUri, `lumen-remote-${record.id.replace(/[^A-Za-z0-9_-]/g, '-')}.json`, 'application/json');
    await files.writeAsStringAsync(uri, JSON.stringify({ format: 'lumen-retained-sync-version', version: 1, commit: record.commit, localEntities: record.localEntities, note: '包含远端完整更改和本机保留的文本；附件以哈希引用，原件仍在 WebDAV 同步库。' }, null, 2));
    Alert.alert('远端版本已保存', '已保存到所选文件夹，可取回完整文本与附件索引。');
  });
  return <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Text style={styles.heading}>在每台设备上接着学</Text>
    <Text style={styles.description}>使用你自己的 WebDAV 文件夹。在 Android、Windows 和 Mac 上填写相同的地址和资料库名称。</Text>
    <View style={styles.card}>
      <Text style={styles.label}>WebDAV 文件夹</Text>
      <TextInput value={endpoint} onChangeText={setEndpoint} autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!busy && !settings?.device_id} placeholder="https://你的服务/remote.php/dav/files/用户/" style={styles.input} accessibilityLabel="WebDAV 文件夹地址" />
      <Text style={styles.label}>资料库名称</Text>
      <TextInput value={libraryId} onChangeText={setLibraryId} autoCapitalize="none" autoCorrect={false} editable={!busy && !settings?.device_id} style={styles.input} accessibilityLabel="同步资料库名称" />
      <Text style={styles.label}>用户名</Text>
      <TextInput value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} editable={!busy} style={styles.input} accessibilityLabel="WebDAV 用户名" />
      <Text style={styles.label}>应用密码</Text>
      <TextInput value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} editable={!busy} style={styles.input} accessibilityLabel="WebDAV 应用密码" placeholder="仅安全保存在这台设备" />
      <View style={styles.consent}><Switch value={consent} onValueChange={setConsent} disabled={busy} accessibilityLabel="允许同步学习资料" /><Text style={styles.consentText}>我同意将图谱、文档、对话、学习记录和原始附件同步到此服务。AI 密钥不会同步。服务管理者可能读取资料。</Text></View>
      <Pressable style={[styles.button, (!consent || busy) && styles.disabled]} disabled={!consent || busy} onPress={() => { void save(); }}><Text style={styles.buttonText}>{settings?.device_id ? '更新凭据并启用同步' : '启用自动同步'}</Text></Pressable>
    </View>
    <View style={styles.card}>
      <View style={styles.statusRow}>{(busy || settings?.status === 'running') && <ActivityIndicator color={colors.blue} />}<Text style={styles.status}>{statusText[settings?.status ?? 'paused']}</Text></View>
      {settings?.last_success_at && <Text style={styles.description}>最近完成：{new Date(settings.last_success_at).toLocaleString()}</Text>}
      {settings?.last_error && <Text style={styles.error}>{settings.last_error}</Text>}
      {settings?.background_error && <Text style={styles.description}>{settings.background_error}</Text>}
      <Text style={styles.description}>打开应用后自动同步；后台同步由 Android 按网络和电量安排，强行停止应用后需重新打开。离线修改保存在本机。</Text>
      {Boolean(settings?.enabled) && <View style={styles.actions}>
        <Pressable disabled={busy} onPress={() => { void perform(() => runSync(db, true)); }} style={styles.secondary}><Text style={styles.link}>立即同步</Text></Pressable>
        <Pressable disabled={busy} onPress={() => { void perform(async () => { await disableSync(db); await refreshBackgroundSync(db); }); }} style={styles.secondary}><Text style={styles.link}>暂停</Text></Pressable>
      </View>}
      {!settings?.enabled && Boolean(settings?.device_id) && <Text style={styles.description}>填入用户名和应用密码即可恢复。暂停不会删除本机或服务端资料。</Text>}
    </View>
    {blocked.map((record) => <View key={record.id} style={styles.card}>
      <Text style={styles.status}>{record.resolved_at ? '已保留的远端版本' : '删除与本机资料存在关联'}</Text>
      <Text style={styles.description}>{record.resolved_at ? '已按你的选择保留内容，原远端版本仍可查看和导出。' : record.reason}</Text>
      <Text style={styles.description}>远端 {record.commit.changes.length} 项改动 · 本机相关资料 {record.localEntities.length} 项</Text>
      {!record.resolved_at && <Pressable disabled={busy} onPress={() => keepLocal(record)} style={styles.button}><Text style={styles.buttonText}>保留本机并继续同步</Text></Pressable>}
      <View style={styles.actions}>
        <Pressable onPress={() => setExpandedRecord(expandedRecord === record.id ? null : record.id)} style={styles.secondary}><Text style={styles.link}>{expandedRecord === record.id ? '收起版本' : '查看涉及的资料'}</Text></Pressable>
        <Pressable disabled={busy} onPress={() => { void exportRecord(record); }} style={styles.secondary}><Text style={styles.link}>导出远端版本</Text></Pressable>
      </View>
      {expandedRecord === record.id && <View style={styles.version}>
        <Text style={styles.label}>远端完整更改</Text>
        {record.commit.changes.map(({ entity }) => <View key={`${entity.kind}:${entity.id}`} style={styles.version}>
          <Text selectable style={styles.label}>{String(entity.data?.title ?? record.localEntities.find((item) => item.kind === entity.kind && item.id === entity.id)?.data?.title ?? entity.id)} · {entity.data === null ? '删除' : '编辑'}</Text>
          <Text selectable style={styles.preview}>{entity.data ? typeof entity.data.body === 'string' ? entity.data.body : JSON.stringify(entity.data, null, 2) : '此远端版本删除了该项。'}</Text>
        </View>)}
        <Text style={styles.label}>本机保留的关联资料</Text>
        {record.localEntities.map((entity) => <Text selectable key={`${entity.kind}:${entity.id}`} style={styles.description}>{String(entity.data?.title ?? entity.data?.body ?? entity.id).slice(0, 150)}</Text>)}
      </View>}
    </View>)}
    {conflicts.length > 0 && <Text style={styles.heading}>选择要继续使用的版本 · {conflicts.length}</Text>}
    {conflicts.map((conflict) => <View key={conflict.key} style={styles.card}>
      <Text style={styles.status}>{String(conflict.versions[0]?.entity.data?.title ?? conflict.versions[0]?.entity.kind ?? '资料')}</Text>
      <Text style={styles.description}>设备离线时同时改动了这份资料。所有版本都已保留，请阅读后选择或合并。</Text>
      {conflict.versions.map((version, index) => <View key={version.revision} style={styles.version}>
        <Text style={styles.label}>版本 {index + 1}{version.entity.data === null ? ' · 已删除' : ''}</Text>
        <Text selectable style={styles.preview}>{version.entity.data === null ? '此版本删除了该资料。' : typeof version.entity.data.body === 'string' ? version.entity.data.body : JSON.stringify(version.entity.data, null, 2)}</Text>
        <View style={styles.actions}><Pressable disabled={busy} onPress={() => resolve(conflict, version.revision)} style={styles.secondary}><Text style={styles.link}>使用此版本</Text></Pressable>
          {typeof version.entity.data?.body === 'string' && <Pressable disabled={busy} onPress={() => setEditing({ key: conflict.key, revision: version.revision, body: String(version.entity.data?.body) })} style={styles.secondary}><Text style={styles.link}>编辑合并</Text></Pressable>}
        </View>
      </View>)}
      {editing?.key === conflict.key && <View style={styles.version}><Text style={styles.label}>合并后的文档</Text><TextInput multiline value={editing.body} onChangeText={(body) => setEditing({ ...editing, body })} style={[styles.input, styles.editor]} textAlignVertical="top" accessibilityLabel="合并后的 Markdown" /><Pressable disabled={busy} onPress={() => resolve(conflict, editing.revision, editing.body)} style={styles.button}><Text style={styles.buttonText}>保存合并</Text></Pressable></View>}
    </View>)}
  </ScrollView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 20, paddingBottom: 60, gap: 14 },
  heading: { fontSize: 23, fontWeight: '700', color: colors.ink }, description: { color: colors.inkMuted, fontSize: 14, lineHeight: 22 },
  card: { backgroundColor: colors.surface, padding: 18, borderRadius: radii.medium, gap: 12 }, label: { color: colors.ink, fontWeight: '600', fontSize: 14 },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 12, color: colors.ink, backgroundColor: colors.surfaceStrong, fontSize: 15 },
  consent: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 }, consentText: { flex: 1, fontSize: 13, lineHeight: 20, color: colors.inkMuted },
  button: { backgroundColor: colors.blue, borderRadius: 12, alignItems: 'center', padding: 14 }, buttonText: { color: colors.white, fontWeight: '600', fontSize: 15 }, disabled: { opacity: 0.5 },
  status: { color: colors.ink, fontSize: 17, fontWeight: '600' }, statusRow: { flexDirection: 'row', gap: 10, alignItems: 'center' }, error: { color: colors.coral, lineHeight: 22 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, secondary: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.blueSoft }, link: { color: colors.blue, fontWeight: '600' },
  version: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 14, gap: 10 }, preview: { color: colors.ink, lineHeight: 22, fontSize: 14 }, editor: { minHeight: 220 },
});
