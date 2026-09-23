import assert from 'node:assert/strict';
import test from 'node:test';

import { isPrivateIpv4, normalizePublicWebUrl } from '../ai/source-ingestion-policy';

test('public web source normalization removes fragments and retains explicit public URLs', () => {
  assert.equal(
    normalizePublicWebUrl(' https://example.com/a?q=1#secret-fragment '),
    'https://example.com/a?q=1',
  );
  assert.equal(isPrivateIpv4('8.8.8.8'), false);
});

test('public web source policy rejects credentials and literal private network targets', () => {
  assert.throws(() => normalizePublicWebUrl('https://user:password@example.com/a'), /账号或密码/);
  for (const url of [
    'http://localhost/page',
    'http://127.0.0.1/page',
    'http://10.1.2.3/page',
    'http://172.20.1.1/page',
    'http://192.168.1.1/page',
    'http://169.254.1.1/page',
    'http://[::1]/page',
    'http://printer.local/page',
  ]) {
    assert.throws(() => normalizePublicWebUrl(url), /本机和局域网|本地或私有网络/);
  }
});
