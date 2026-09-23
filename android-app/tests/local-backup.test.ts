import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { LAYOUT_DIRECTION_MIGRATION_SQL, LOCAL_BACKUP_MIGRATION_SQL, LOCAL_BACKUP_RECOVERY_SQL } from '../data/database';
import {
  nextLocalBackupSlot,
  writeLocalBackupSnapshot,
  type BackupFileStore,
  type LocalBackupSnapshot,
} from '../data/local-backup-format';
import { parseLocalBackupSnapshot } from '../data/local-backup-import';

function createBackupDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE documents (id TEXT PRIMARY KEY);
    CREATE TABLE nodes (id TEXT PRIMARY KEY);
    CREATE TABLE edges (id TEXT PRIMARY KEY);
    CREATE TABLE node_answers (id TEXT PRIMARY KEY);
    CREATE TABLE prompt_templates (id TEXT PRIMARY KEY);
    ${LOCAL_BACKUP_MIGRATION_SQL}
  `);
  return db;
}

test('v8 migration coalesces every backed-up data mutation into one pending job', () => {
  const db = createBackupDatabase();
  db.exec(`UPDATE local_backup_settings SET directory_uri = 'content://backup', enabled = 1 WHERE id = 1`);
  for (const table of ['projects', 'documents', 'nodes', 'edges', 'node_answers', 'prompt_templates']) {
    db.exec(`INSERT INTO ${table} (id) VALUES ('${table}-1')`);
  }
  const job = db.prepare('SELECT status, revision, synced_revision FROM local_backup_jobs WHERE id = 1').get() as {
    status: string;
    revision: number;
    synced_revision: number;
  };
  assert.equal(job.status, 'pending');
  assert.equal(job.revision, 6);
  assert.equal(job.synced_revision, 0);

  db.exec(`UPDATE local_backup_jobs SET status = 'running', target_revision = revision WHERE id = 1`);
  db.exec(`UPDATE nodes SET id = 'nodes-2' WHERE id = 'nodes-1'`);
  const running = db.prepare('SELECT status, revision, target_revision FROM local_backup_jobs WHERE id = 1').get() as {
    status: string;
    revision: number;
    target_revision: number;
  };
  assert.equal(running.status, 'running');
  assert.equal(running.revision, 7);
  assert.equal(running.target_revision, 6);
  db.close();
});

test('startup recovery returns an interrupted running backup to the foreground queue', () => {
  const db = createBackupDatabase();
  db.exec(`
    UPDATE local_backup_settings SET directory_uri = 'content://backup', enabled = 1 WHERE id = 1;
    UPDATE local_backup_jobs
    SET status = 'running', revision = 4, synced_revision = 2, target_revision = 4,
        progress_current = 3, progress_label = 'writing'
    WHERE id = 1;
    ${LOCAL_BACKUP_RECOVERY_SQL}
  `);
  const row = db.prepare('SELECT status, target_revision, progress_current, progress_label, last_error FROM local_backup_jobs').get() as {
    status: string;
    target_revision: number | null;
    progress_current: number;
    progress_label: string | null;
    last_error: string;
  };
  assert.equal(row.status, 'pending');
  assert.equal(row.target_revision, null);
  assert.equal(row.progress_current, 0);
  assert.equal(row.progress_label, null);
  assert.match(row.last_error, /中断/);
  db.close();
});

test('v9 migration gives existing projects a safe vertical default and validates horizontal values', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    INSERT INTO projects VALUES ('old-project');
    ${LAYOUT_DIRECTION_MIGRATION_SQL}
  `);
  assert.equal(
    (db.prepare('SELECT layout_direction FROM projects WHERE id = ?').get('old-project') as { layout_direction: string }).layout_direction,
    'vertical',
  );
  db.exec(`UPDATE projects SET layout_direction = 'horizontal' WHERE id = 'old-project'`);
  assert.throws(() => db.exec(`UPDATE projects SET layout_direction = 'diagonal' WHERE id = 'old-project'`), /CHECK/);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9);
  db.close();
});

test('A/B backup writes completion marker before switching the latest pointer', async () => {
  const files: string[] = [];
  const store: BackupFileStore = {
    async write(fileName) {
      files.push(fileName);
    },
    async directory(directoryName) {
      files.push(`${directoryName}/`);
      return this;
    },
  };
  const snapshot = {
    format: 'learnstuff-app-backup',
    version: 2,
    exportedAt: '2026-07-25T00:00:00.000Z',
    revision: 9,
    projects: [],
    answers: [],
    promptTemplates: [],
    topics: [],
    aiUnderstandingDocuments: [],
    projectAiScopeSettings: [],
    favorites: [],
    favoriteBindings: [],
    exclusions: ['secrets'],
  } satisfies LocalBackupSnapshot;

  assert.equal(nextLocalBackupSlot(null), 'a');
  assert.equal(nextLocalBackupSlot('a'), 'b');
  await writeLocalBackupSnapshot(store, snapshot, 'b');
  assert.deepEqual(files, [
    'learnstuff-backup-slot-b.json',
    'learnstuff-backup-slot-b.md',
    '项目/',
    'learnstuff-projects-index.json',
    'README-LearnStuff-Backup.md',
    'learnstuff-backup-commit-b.json',
    'learnstuff-backup-latest.json',
  ]);
});

test('old v2 backup remains readable and validates every embedded v1 project before restore', () => {
  const snapshot = {
    format: 'learnstuff-app-backup',
    version: 2,
    exportedAt: '2026-07-25T00:00:00.000Z',
    revision: 3,
    projects: [{
      format: 'learnstuff-graph',
      version: 1,
      exportedAt: '2026-07-25T00:00:00.000Z',
      project: {
        id: 'old-project',
        title: '旧备份',
        sourceText: '旧资料',
        createdAt: 'now',
        updatedAt: 'now',
      },
      documents: [{
        id: 'd1', path: '目标.md', title: '目标', body: '# 目标', origin: 'source',
        createdAt: 'now', updatedAt: 'now',
      }],
      nodes: [{
        id: 'n1', title: '目标', subtitle: '', x: 0, y: 0, importance: 10,
        status: 'essential', order: 0, documentId: 'd1',
      }],
      edges: [],
      savedAnswers: [],
    }],
    answers: [],
    promptTemplates: [],
    topics: [],
    aiUnderstandingDocuments: [],
    projectAiScopeSettings: [],
    favorites: [],
    favoriteBindings: [],
    exclusions: ['secrets'],
  };
  const parsed = parseLocalBackupSnapshot(JSON.stringify(snapshot));
  assert.equal(parsed.version, 2);
  assert.equal(parsed.projects[0].project.contentPolicy?.mode, 'learning');
  assert.equal(parsed.projects[0].project.topicId, null);
});

test('backup restore parser rejects unrelated JSON and invalid embedded graph references before writing', () => {
  assert.throws(
    () => parseLocalBackupSnapshot(JSON.stringify({ format: 'other', version: 3 })),
    /LearnStuff 自动备份/,
  );
  const invalid = {
    format: 'learnstuff-app-backup',
    version: 3,
    exportedAt: 'now',
    revision: 1,
    projects: [{
      format: 'learnstuff-graph',
      version: 2,
      exportedAt: 'now',
      project: { id: 'p', title: '坏图', sourceText: '', createdAt: 'now', updatedAt: 'now' },
      documents: [{ id: 'd', path: 'a.md', title: 'a', body: '# a', origin: 'source', createdAt: 'now', updatedAt: 'now' }],
      nodes: [{ id: 'n', title: 'n', subtitle: '', x: 0, y: 0, importance: 10, status: 'essential', order: 0, documentId: 'missing' }],
      edges: [],
      savedAnswers: [],
    }],
    answers: [],
  };
  assert.throws(() => parseLocalBackupSnapshot(JSON.stringify(invalid)), /Markdown 不存在/);
});

test('a failed slot write never advances the latest pointer', async () => {
  const files: string[] = [];
  const store: BackupFileStore = {
    async write(fileName) {
      files.push(fileName);
      if (fileName === 'learnstuff-backup-slot-a.md') throw new Error('disk full');
    },
    async directory() {
      return this;
    },
  };
  const snapshot = {
    format: 'learnstuff-app-backup',
    version: 2,
    exportedAt: '2026-07-25T00:00:00.000Z',
    revision: 10,
    projects: [],
    answers: [],
    promptTemplates: [],
    topics: [],
    aiUnderstandingDocuments: [],
    projectAiScopeSettings: [],
    favorites: [],
    favoriteBindings: [],
    exclusions: [],
  } satisfies LocalBackupSnapshot;

  await assert.rejects(() => writeLocalBackupSnapshot(store, snapshot, 'a'), /disk full/);
  assert.ok(!files.includes('learnstuff-backup-latest.json'));
});

test('automatic backup writes a readable subfolder for every project without deleting history', async () => {
  const files: string[] = [];
  const prefix = new WeakMap<object, string>();
  const makeStore = (path = ''): BackupFileStore => {
    const store: BackupFileStore = {
      async write(fileName) {
        files.push(`${path}${fileName}`);
      },
      async directory(directoryName) {
        return makeStore(`${path}${directoryName}/`);
      },
    };
    prefix.set(store, path);
    return store;
  };
  const snapshot = {
    format: 'learnstuff-app-backup',
    version: 2,
    exportedAt: '2026-07-26T00:00:00.000Z',
    revision: 11,
    projects: [{
      format: 'learnstuff-graph',
      version: 1,
      exportedAt: '2026-07-26T00:00:00.000Z',
      project: {
        id: 'project-one',
        title: '图论 / 入门',
        sourceText: '',
        createdAt: 'now',
        updatedAt: 'now',
        layoutDirection: 'horizontal',
      },
      documents: [{
        id: 'd1', path: '目标.md', title: '目标', body: '# 目标', origin: 'source',
        createdAt: 'now', updatedAt: 'now',
      }],
      nodes: [{
        id: 'n1', title: '目标', subtitle: '', x: 0, y: 0, importance: 10,
        status: 'essential', order: 0, documentId: 'd1',
      }],
      edges: [],
      savedAnswers: [],
    }],
    answers: [{
      id: 'a1', projectId: 'project-one', nodeId: 'n1', jobId: null,
      question: '为什么？', body: '# 回答', adapter: 'local', actualModel: null,
      saved: false, createdAt: 'now', updatedAt: 'now',
    }],
    promptTemplates: [],
    topics: [],
    aiUnderstandingDocuments: [],
    projectAiScopeSettings: [],
    favorites: [],
    favoriteBindings: [],
    exclusions: [],
  } satisfies LocalBackupSnapshot;

  await writeLocalBackupSnapshot(makeStore(), snapshot, 'a');
  assert.ok(files.some((name) => name.includes('项目/图论-入门-roject-one/learnstuff.graph.json')));
  assert.ok(files.some((name) => name.includes('/Markdown/001-目标.md')));
  assert.ok(files.some((name) => name.includes('/回答/001-未收藏-为什么？.md')));
  assert.ok(files.includes('learnstuff-projects-index.json'));
  assert.ok(files.every((name) => !name.includes('delete')));
});
