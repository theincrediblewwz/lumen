import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SQLiteDatabase } from 'expo-sqlite';

import { migrateDatabase } from '../data/database';
import { importPortableManifestWithMapping, createPortableManifest } from '../data/portable-knowledge';
import { PORTABLE_ASSETS_FORMAT, PORTABLE_ASSETS_VERSION, validatePortableAssetsIndex } from '../data/portable-assets';

async function fixture() {
  const raw = new DatabaseSync(':memory:');
  const api = {
    execAsync: async (sql: string) => { raw.exec(sql); },
    runAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).run(...args),
    getFirstAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).all(...args),
    withExclusiveTransactionAsync: async (work: (tx: SQLiteDatabase) => Promise<void>) => {
      raw.exec('BEGIN IMMEDIATE');
      try { await work(api as unknown as SQLiteDatabase); raw.exec('COMMIT'); }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
  const db = api as unknown as SQLiteDatabase;
  await migrateDatabase(db);
  raw.exec(`INSERT INTO source_items
    (id,project_id,kind,title,original_name,media_type,content_hash,byte_size,extraction_status,derived_document_id,created_at,updated_at)
    VALUES('source-pdf','project-transformer','pdf','合成 PDF','paper.pdf','application/pdf','text-hash',10,'ready','doc-transformer','2026-09-28','2026-09-28');
    INSERT INTO source_segments(id,source_item_id,ordinal,locator_type,locator,body,content_hash)
    VALUES('segment-pdf','source-pdf',0,'page','1','合成正文','segment-hash');`);
  return { raw, db, manifest: await createPortableManifest(db, 'project-transformer') };
}

test('asset sidecar binds source, manifest, size and safe digest filename without claiming bytes inside graph JSON', async t => {
  const { raw, manifest } = await fixture(); t.after(() => raw.close());
  assert.equal(manifest.sourceItems?.[0].originalAssetIncluded, false);
  const digest = 'a'.repeat(64);
  const index = {
    format: PORTABLE_ASSETS_FORMAT, version: PORTABLE_ASSETS_VERSION,
    projectId: manifest.project.id, manifestSha256: digest,
    assets: [{ sourceId: 'source-pdf', sha256: digest, size: 10, mediaType: 'application/pdf', fileName: `${digest}.pdf` }],
    missingSourceIds: [],
  };
  assert.equal(validatePortableAssetsIndex(JSON.stringify(index), manifest, digest).assets.length, 1);
  assert.throws(() => validatePortableAssetsIndex(JSON.stringify(index), manifest, 'b'.repeat(64)), /不匹配/);
  assert.throws(() => validatePortableAssetsIndex(JSON.stringify({ ...index, assets: [{ ...index.assets[0], fileName: '../paper.pdf' }] }), manifest, digest), /文件名/);
  assert.throws(() => validatePortableAssetsIndex(JSON.stringify({ ...index, assets: [] }), manifest, digest), /未列入/);
  assert.throws(() => validatePortableAssetsIndex(JSON.stringify({ ...index, assets: [index.assets[0], index.assets[0]] }), manifest, digest), /重复/);
  assert.equal(validatePortableAssetsIndex(JSON.stringify({ ...index, assets: [], missingSourceIds: ['source-pdf'] }), manifest, digest).missingSourceIds.length, 1);
});

test('restored original attaches to imported copy atomically; late SQL failure leaves no project', async t => {
  const { raw, db, manifest } = await fixture(); t.after(() => raw.close());
  const digest = 'b'.repeat(64);
  const uri = `file:///private/sync-blobs/${digest}`;
  const copy = await importPortableManifestWithMapping(db, manifest, new Map([['source-pdf', uri]]));
  const importedSourceId = copy.sourceItemIds.get('source-pdf');
  assert.ok(importedSourceId);
  const imported = raw.prepare('SELECT asset_uri FROM source_items WHERE id=?').get(importedSourceId) as { asset_uri: string };
  assert.equal(imported.asset_uri, uri);
  const before = (raw.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
  await assert.rejects(importPortableManifestWithMapping(db, manifest, new Map([['source-pdf', 'content://untrusted']])), /路径无效/);
  raw.exec("CREATE TRIGGER reject_asset_attach BEFORE UPDATE OF asset_uri ON source_items WHEN NEW.asset_uri IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected attach failure'); END");
  await assert.rejects(importPortableManifestWithMapping(db, manifest, new Map([['source-pdf', uri]])), /injected attach failure/);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n, before);
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
});
