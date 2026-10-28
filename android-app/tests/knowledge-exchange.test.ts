import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from '../data/database';
import { importKnowledgeFile, decodeKnowledgeFile, encodeKnowledgeFile } from '../data/knowledge-library-transfer';
import { loadKnowledgeLibrary, saveKnowledgeEntry } from '../data/knowledge-library';
import { copyKnowledgeLibrary, saveKnowledgeInLibrary, validateKnowledgeLibrary } from '../../src/knowledge/core';

const root = resolve('..'), python = process.env.LSQ_EXCHANGE_PYTHON ?? 'python';
const parent = process.env.LSQ_EXCHANGE_QA ?? resolve(root, '.artifacts/knowledge-exchange-tests');
function bridge(direction: string, source: string, output: string, base?: string) {
  return execFileSync(python, ['-B', join(root, 'scripts/knowledge_exchange.py'), direction, '--source', source, '--output', output, ...(base ? ['--base', base] : [])], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
}
function fixture() {
  mkdirSync(parent, { recursive: true });
  const folder = mkdtempSync(join(parent, 'sqlite-roundtrip-')), source = join(folder, 'source');
  mkdirSync(join(source, 'notes'), { recursive: true });
  writeFileSync(join(source, 'notes', 'note_1.md'), '---\nformat: knowledge-document/v1\nrecord_type: note\nid: note_1\ntitle: 自己的理解\nscope_type: global\ncreated_at: 2026-10-08\nextensions:\n  future_app:\n    untouched: [中文, yes]\n---\n\n理解原文。🌍\n\n');
  const packagePath = join(folder, 'incoming'); bridge('to-lsq', source, packagePath);
  return { folder, source, packagePath, incoming: decodeKnowledgeFile(readFileSync(join(packagePath, 'knowledge-library.json'), 'utf8')) };
}
async function database() {
  const raw = new DatabaseSync(':memory:');
  const api = {
    execAsync: async (sql: string) => { raw.exec(sql); },
    getFirstAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).all(...args),
    runAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).run(...args),
    withExclusiveTransactionAsync: async (fn: (db: SQLiteDatabase) => Promise<void>) => {
      raw.exec('BEGIN IMMEDIATE'); try { await fn(api as unknown as SQLiteDatabase); raw.exec('COMMIT'); } catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
  const db = api as unknown as SQLiteDatabase; await migrateDatabase(db);
  return { raw, db };
}

test('HistoryandKnowledge v1 survives actual SQLite copy import, learner edit, export and feedback', async t => {
  const f = fixture(), { raw, db } = await database(); t.after(() => raw.close());
  const sourceBefore = readFileSync(join(f.source, 'notes/note_1.md'));
  assert.equal(await importKnowledgeFile(db, f.incoming), 1);
  let loaded = await loadKnowledgeLibrary(db);
  assert.notEqual(loaded.entries[0].id, f.incoming.entries[0].id, 'actual importer creates an independent copy');
  assert.equal(loaded.entries[0].source, f.incoming.entries[0].source, 'provenance survives ID remapping');
  assert.equal(loaded.entries[0].body, '\n理解原文。🌍\n\n');
  const original = loaded.entries[0];
  await saveKnowledgeEntry(db, { id: original.id, expectedRevision: original.revision_id, kind: original.kind, title: original.title, body: original.body + '新的理解。\n\n', source: original.source });
  loaded = await loadKnowledgeLibrary(db);
  assert.equal(loaded.revisions.length, 2);
  assert.equal(loaded.revisions.find(row => row.id === original.revision_id)?.body, original.body);
  const outgoing = join(f.folder, 'edited.json'); writeFileSync(outgoing, encodeKnowledgeFile(loaded));
  const feedback = join(f.folder, 'feedback'); bridge('from-lsq', outgoing, feedback, f.packagePath);
  const body = readFileSync(join(feedback, 'notes/note_1.md'), 'utf8');
  assert(body.includes('新的理解。\n\n')); assert(body.includes('future_app:')); assert(body.includes('untouched:')); assert(body.includes('中文'));
  assert(body.includes("created_at: '2026-10-08'"), 'opaque source date is retained, not guessed');
  const record = JSON.parse(readFileSync(join(feedback, 'exchange-records.json'), 'utf8')).records[0];
  assert.deepEqual(record.metadata.extensions.future_app.untouched, ['中文', 'yes']);
  assert.equal(record.metadata.extensions.learnstuffquickly.revisions.length, 2);
  assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 19);
  assert.deepEqual(loaded.bindings, []); assert.deepEqual(loaded.settings, []);
  assert.deepEqual(readFileSync(join(f.source, 'notes/note_1.md')), sourceBefore);
});

test('desktop copy contract returns the same public knowledge format after normal learner editing', () => {
  const f = fixture();
  const copied = copyKnowledgeLibrary(f.incoming).library;
  const old = copied.entries[0];
  const result = saveKnowledgeInLibrary(copied, { id: old.id, expectedRevision: old.revision_id, kind: 'experience', title: '形成的经验', body: old.body + '实际使用中的经验。\n', source: old.source });
  validateKnowledgeLibrary(result.library);
  const outgoing = join(f.folder, 'desktop.json'); writeFileSync(outgoing, encodeKnowledgeFile(result.library));
  const output = join(f.folder, 'desktop-feedback'); bridge('from-lsq', outgoing, output, f.packagePath);
  const record = JSON.parse(readFileSync(join(output, 'exchange-records.json'), 'utf8')).records[0];
  assert.equal(record.metadata.id, 'note_1');
  assert.equal(record.metadata.extensions.learnstuffquickly.kind, 'experience');
  assert.deepEqual(record.metadata.extensions.future_app.untouched, ['中文', 'yes']);
  assert.equal(record.metadata.extensions.learnstuffquickly.revisions.length, 2);
});
