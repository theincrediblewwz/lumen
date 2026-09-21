import { assertSync, checkAbort, LIMITS, SyncError, utf8Decode } from './codec';
import type { SyncTransport, TransportEntry } from './types';

export interface WebDavOptions {
  endpoint: string;
  authorization?: string;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Tests only: permits literal loopback hosts, never an arbitrary HTTP NAS. */
  allowLocalHttpForTests?: boolean;
}
export function validateWebDavEndpoint(endpoint: string, allowLocalHttpForTests = false): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new SyncError('invalid-endpoint'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  assertSync(url.protocol === 'https:' || (allowLocalHttpForTests && local && url.protocol === 'http:'), 'https-required');
  assertSync(!url.username && !url.password && !url.search && !url.hash, 'endpoint-credentials-or-query');
  assertSync(!/[\\\u0000-\u0020]/.test(endpoint), 'invalid-endpoint');
  // A directory URL avoids resolving the namespace as a sibling of the configured folder.
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.toString();
}
function safePath(path: string): string {
  assertSync(path.length > 0 && path.length <= 512 && /^[A-Za-z0-9_./-]+$/.test(path) && !path.startsWith('/') && !path.includes('//'), 'invalid-remote-path');
  assertSync(path.split('/').filter(Boolean).every(part => part !== '.' && part !== '..'), 'invalid-remote-path');
  return path;
}
function xmlText(text: string): string {
  assertSync(!text.includes('<'), 'invalid-webdav-xml');
  return text.replace(/&([^;]{1,20});/g, (_, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (named[entity] !== undefined) return named[entity];
    const code = /^#x[0-9a-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : /^#[0-9]+$/.test(entity) ? Number(entity.slice(1)) : 0;
    assertSync(code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff), 'invalid-webdav-entity');
    return String.fromCodePoint(code);
  });
}
/** Deliberately limited DAV XML parser: no DTD, external entities, document execution or DOM. */
export function parseWebDavListing(xml: string, endpoint: string, requestedPath: string): TransportEntry[] {
  assertSync(xml.length <= LIMITS.listingBytes && !/<!|<\?/i.test(xml.replace(/^\s*<\?xml\s[^?]*\?>/, '')), 'unsafe-webdav-xml');
  const base = new URL(endpoint); const requested = safePath(requestedPath);
  const entries = new Map<string, TransportEntry>();
  const responses = xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?response\s*>/g);
  for (const response of responses) {
    const body = response[1];
    const hrefMatch = body.match(/<(?:[A-Za-z_][\w.-]*:)?href(?:\s[^>]*)?>([^<]*)<\/(?:[A-Za-z_][\w.-]*:)?href\s*>/);
    assertSync(hrefMatch, 'webdav-href-missing');
    const href = xmlText(hrefMatch[1].trim());
    assertSync(!/[\\\u0000-\u0020]/.test(href), 'unsafe-webdav-href');
    let url: URL;
    try { url = new URL(href, new URL(requested, base)); } catch { throw new SyncError('unsafe-webdav-href'); }
    assertSync(url.origin === base.origin && !url.username && !url.password && !url.search && !url.hash && url.pathname.startsWith(base.pathname), 'webdav-path-escape');
    let relative: string;
    try { relative = decodeURIComponent(url.pathname.slice(base.pathname.length)); } catch { throw new SyncError('invalid-webdav-encoding'); }
    safePath(relative);
    const directory = /<(?:[A-Za-z_][\w.-]*:)?collection\s*\/?\s*>/.test(body);
    if (directory && !relative.endsWith('/')) relative += '/';
    assertSync(relative === requested || (relative.startsWith(requested) && !relative.slice(requested.length).replace(/\/$/, '').includes('/')), 'webdav-depth-violation');
    // A failed resource response is not silently treated as a complete listing.
    const statusCodes = [...body.matchAll(/<(?:[A-Za-z_][\w.-]*:)?status\s*>HTTP\/[^ ]+ ([0-9]{3})[^<]*<\//g)].map(match => Number(match[1]));
    assertSync(statusCodes.length > 0 && statusCodes.some(status => status >= 200 && status < 300), 'webdav-resource-failed');
    entries.set(relative, { path: relative, directory });
    assertSync(entries.size <= LIMITS.commits + 1, 'listing-count-limit');
  }
  assertSync(/<(?:[A-Za-z_][\w.-]*:)?multistatus(?:\s|>)/.test(xml), 'invalid-webdav-listing');
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function createWebDavTransport(options: WebDavOptions): SyncTransport {
  const endpoint = validateWebDavEndpoint(options.endpoint, options.allowLocalHttpForTests);
  const timeout = options.timeoutMs ?? 30000;
  assertSync(Number.isFinite(timeout) && timeout >= 10 && timeout <= 120000, 'invalid-timeout');
  assertSync(!options.authorization || !/[\r\n]/.test(options.authorization), 'invalid-authorization');
  async function request(method: string, path: string, maxBytes: number, signal?: AbortSignal, bytes?: Uint8Array, extraHeaders: Record<string, string> = {}) {
    checkAbort(signal); safePath(path);
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectCancelled: ((reason: SyncError) => void) | undefined;
    const abort = () => { controller.abort(); rejectCancelled?.(new SyncError('cancelled')); };
    signal?.addEventListener('abort', abort, { once: true });
    const interrupted = new Promise<never>((_, reject) => {
      rejectCancelled = reject;
      timer = setTimeout(() => { controller.abort(); reject(new SyncError('network-timeout')); }, timeout);
    });
    const operation = async () => {
      const headers: Record<string, string> = { ...extraHeaders };
      if (options.authorization) headers.Authorization = options.authorization;
      const response = await options.fetch(new URL(path, endpoint).toString(), {
        method, headers, signal: controller.signal, redirect: 'manual',
        ...(bytes ? { body: bytes.slice().buffer as ArrayBuffer } : {}),
      });
      assertSync(!response.redirected && !(response.status >= 300 && response.status < 400), 'redirect-rejected');
      // Error bodies can contain credentials or user content. Never read them.
      if (!(response.status >= 200 && response.status < 300)) return { status: response.status, bytes: new Uint8Array() };
      if (maxBytes === 0) return { status: response.status, bytes: new Uint8Array() };
      const contentLength = response.headers.get('content-length');
      assertSync(!contentLength || (/^[0-9]+$/.test(contentLength) && Number(contentLength) <= maxBytes), 'response-size-limit');
      const reader = response.body?.getReader?.();
      let result: Uint8Array;
      if (reader) {
        const parts: Uint8Array[] = []; let length = 0;
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            length += chunk.value.length; assertSync(length <= maxBytes, 'response-size-limit'); parts.push(chunk.value);
          }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        result = new Uint8Array(length); let offset = 0;
        for (const part of parts) { result.set(part, offset); offset += part.length; }
      } else {
        // RN fetch has no streaming reader: Content-Length is checked before allocation when supplied.
        result = new Uint8Array(await response.arrayBuffer()); assertSync(result.length <= maxBytes, 'response-size-limit');
      }
      return { status: response.status, bytes: result };
    };
    try { return await Promise.race([operation(), interrupted]); }
    catch (error) { if (error instanceof SyncError) throw error; throw new SyncError(signal?.aborted ? 'cancelled' : 'network-failed'); }
    finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return {
    async ensureDirectories(paths, signal) {
      for (const path of paths) {
        const response = await request('MKCOL', path, 0, signal);
        assertSync(response.status === 201 || response.status === 405, `webdav-mkcol-${response.status}`);
      }
    },
    async list(path, signal) {
      const response = await request('PROPFIND', path, LIMITS.listingBytes, signal, undefined, { Depth: '1' });
      assertSync(response.status === 207, `webdav-list-${response.status}`);
      return parseWebDavListing(utf8Decode(response.bytes), endpoint, path);
    },
    async read(path, maxBytes, signal) {
      assertSync(Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= LIMITS.blobBytes, 'invalid-read-limit');
      // Empty objects still need their body checked; zero is reserved for body-less method responses.
      const response = await request('GET', path, Math.max(1, maxBytes), signal);
      if (response.status === 404) return null;
      assertSync(response.status === 200, `webdav-read-${response.status}`);
      assertSync(response.bytes.length <= maxBytes, 'response-size-limit'); return response.bytes;
    },
    async writeImmutable(path, bytes, signal) {
      assertSync(bytes.length <= LIMITS.blobBytes, 'write-size-limit');
      const existing = await this.read(path, Math.max(1, bytes.length), signal);
      if (existing !== null) {
        assertSync(existing.length === bytes.length && existing.every((value, i) => value === bytes[i]), 'immutable-object-collision'); return;
      }
      const response = await request('PUT', path, 0, signal, bytes, { 'If-None-Match': '*', 'Content-Type': 'application/octet-stream' });
      assertSync([200, 201, 204, 412].includes(response.status), `webdav-write-${response.status}`);
      const confirmed = await this.read(path, Math.max(1, bytes.length), signal);
      assertSync(confirmed !== null && confirmed.length === bytes.length && confirmed.every((value, i) => value === bytes[i]), 'immutable-write-not-confirmed');
    },
  };
}
