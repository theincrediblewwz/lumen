import type { SQLiteDatabase } from 'expo-sqlite';
import {documentAssets} from './rich-document';

import type {
  SourceItem,
  SourceItemKind,
  SourceSegment,
} from '@/types/domain';

type SourceItemRow = {
  id: string;
  project_id: string;
  kind: SourceItemKind;
  title: string;
  original_name: string | null;
  media_type: string;
  asset_uri: string | null;
  source_url: string | null;
  content_hash: string;
  byte_size: number;
  extraction_status: SourceItem['extractionStatus'];
  extraction_error: string | null;
  derived_document_id: string;
  created_at: string;
  updated_at: string;
  segment_count: number;
  extracted_characters: number;
};

type SourceSegmentRow = {
  id: string;
  source_item_id: string;
  ordinal: number;
  locator_type: SourceSegment['locatorType'];
  locator: string;
  body: string;
  content_hash: string;
};

export type NewSourceSegment = Omit<SourceSegment, 'id' | 'sourceItemId'>;

export type NewSourceItem = {
  projectId: string;
  kind: SourceItemKind;
  title: string;
  originalName: string | null;
  mediaType: string;
  assetUri: string | null;
  sourceUrl: string | null;
  contentHash: string;
  byteSize: number;
  segments: NewSourceSegment[];
};

export type FailedSourceItem = Omit<NewSourceItem, 'segments'> & {
  error: string;
};

const sourceItemSelect = `
  SELECT item.*,
    (SELECT COUNT(*) FROM source_segments segment WHERE segment.source_item_id = item.id) AS segment_count,
    (SELECT COALESCE(SUM(LENGTH(segment.body)), 0) FROM source_segments segment WHERE segment.source_item_id = item.id) AS extracted_characters
  FROM source_items item
`;

export async function listProjectSourceItems(db: SQLiteDatabase, projectId: string) {
  const rows = await db.getAllAsync<SourceItemRow>(
    `${sourceItemSelect} WHERE item.project_id = ? ORDER BY item.created_at DESC, item.id DESC`,
    projectId,
  );
  return rows.map(mapSourceItem);
}

export async function listSourceSegments(db: SQLiteDatabase, sourceItemId: string) {
  const rows = await db.getAllAsync<SourceSegmentRow>(
    'SELECT * FROM source_segments WHERE source_item_id = ? ORDER BY ordinal',
    sourceItemId,
  );
  return rows.map(mapSourceSegment);
}

export async function copyProjectSourceItems(
  db: SQLiteDatabase,
  sourceProjectId: string,
  targetProjectId: string,
) {
  if (sourceProjectId === targetProjectId) throw new Error('资料副本必须写入另一个项目');
  const sourceItems = await listProjectSourceItems(db, sourceProjectId);
  let copied = 0;
  for (const source of [...sourceItems].reverse()) {
    const segments = await listSourceSegments(db, source.id);
    const common = {
      projectId: targetProjectId,
      kind: source.kind,
      title: source.title,
      originalName: source.originalName,
      mediaType: source.mediaType,
      assetUri: source.assetUri,
      sourceUrl: source.sourceUrl,
      contentHash: source.contentHash,
      byteSize: source.byteSize,
    };
    if (source.extractionStatus !== 'ready') {
      await recordFailedProjectSourceItem(db, {
        ...common,
        error: source.extractionError ?? '原项目中的资料尚未提取完成',
      });
    } else {
      await addProjectSourceItem(db, {
        ...common,
        segments: segments.map(({ ordinal, locatorType, locator, body, contentHash }) => ({
        ordinal,
        locatorType,
        locator,
        body,
        contentHash,
        })),
      });
    }
    copied += 1;
  }
  return copied;
}

export async function recordFailedProjectSourceItem(db: SQLiteDatabase, input: FailedSourceItem) {
  if (!input.title.trim()) throw new Error('资料标题不能为空');
  const now = new Date().toISOString();
  const cleanTitle = input.title.trim().slice(0, 160);
  const cleanError = input.error.trim().slice(0, 1_000) || '资料提取失败';
  let itemId = createId('source');
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const project = await transaction.getFirstAsync<{ id: string }>(
      'SELECT id FROM projects WHERE id = ?',
      input.projectId,
    );
    if (!project) throw new Error('当前项目不存在');
    const existing = await transaction.getFirstAsync<{
      id: string;
      derived_document_id: string;
    }>(
      'SELECT id, derived_document_id FROM source_items WHERE project_id = ? AND content_hash = ? AND kind = ?',
      input.projectId,
      input.contentHash,
      input.kind,
    );
    const documentBody = buildFailedSourceDocumentBody(input, cleanTitle, cleanError);
    if (existing) {
      itemId = existing.id;
      await transaction.runAsync(
        `UPDATE source_items
         SET extraction_status = 'failed', extraction_error = ?, updated_at = ?
         WHERE id = ?`,
        cleanError,
        now,
        existing.id,
      );
      await transaction.runAsync(
        'UPDATE documents SET title = ?, body = ?, updated_at = ? WHERE id = ?',
        cleanTitle,
        documentBody,
        now,
        existing.derived_document_id,
      );
    } else {
      const documentId = createId('doc');
      await transaction.runAsync(
        `INSERT INTO documents (
          id, project_id, path, title, body, origin, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'source', ?, ?)`,
        documentId,
        input.projectId,
        `资料/${compactTimestamp(now)}-${safePath(cleanTitle)}-提取失败.md`,
        cleanTitle,
        documentBody,
        now,
        now,
      );
      await transaction.runAsync(
        `INSERT INTO source_items (
          id, project_id, kind, title, original_name, media_type, asset_uri, source_url,
          content_hash, byte_size, extraction_status, extraction_error,
          derived_document_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?)`,
        itemId,
        input.projectId,
        input.kind,
        cleanTitle,
        input.originalName,
        input.mediaType,
        input.assetUri,
        input.sourceUrl,
        input.contentHash,
        Math.max(0, Math.floor(input.byteSize)),
        cleanError,
        documentId,
        now,
        now,
      );
    }
    await transaction.runAsync('UPDATE projects SET updated_at = ? WHERE id = ?', now, input.projectId);
  });
  const row = await db.getFirstAsync<SourceItemRow>(`${sourceItemSelect} WHERE item.id = ?`, itemId);
  if (!row) throw new Error('失败资料记录无法读取');
  return mapSourceItem(row);
}

export async function addProjectSourceItem(db: SQLiteDatabase, input: NewSourceItem) {
  if (!input.title.trim()) throw new Error('资料标题不能为空');
  if (!input.segments.length || input.segments.every((segment) => !segment.body.trim())) {
    throw new Error('资料中没有可保存的文字内容');
  }
  const itemId = createId('source');
  const documentId = createId('doc');
  const now = new Date().toISOString();
  const cleanTitle = input.title.trim().slice(0, 160);
  const body = buildSourceDocumentBody(input, cleanTitle);

  try {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      const project = await transaction.getFirstAsync<{ id: string }>(
        'SELECT id FROM projects WHERE id = ?',
        input.projectId,
      );
      if (!project) throw new Error('当前项目不存在');
      await transaction.runAsync(
        `INSERT INTO documents (
          id, project_id, path, title, body, origin, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'source', ?, ?)`,
        documentId,
        input.projectId,
        `资料/${compactTimestamp(now)}-${safePath(cleanTitle)}.md`,
        cleanTitle,
        body,
        now,
        now,
      );
      await transaction.runAsync(
        `INSERT INTO source_items (
          id, project_id, kind, title, original_name, media_type, asset_uri, source_url,
          content_hash, byte_size, extraction_status, extraction_error,
          derived_document_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?, ?)`,
        itemId,
        input.projectId,
        input.kind,
        cleanTitle,
        input.originalName,
        input.mediaType,
        input.assetUri,
        input.sourceUrl,
        input.contentHash,
        Math.max(0, Math.floor(input.byteSize)),
        documentId,
        now,
        now,
      );
      for (const [index, segment] of input.segments.entries()) {
        await transaction.runAsync(
          `INSERT INTO source_segments (
            id, source_item_id, ordinal, locator_type, locator, body, content_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          createId('segment'),
          itemId,
          index,
          segment.locatorType,
          segment.locator,
          segment.body.trim(),
          segment.contentHash,
        );
      }
      await transaction.runAsync(
        'UPDATE projects SET updated_at = ? WHERE id = ?',
        now,
        input.projectId,
      );
    });
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: source_items/u.test(error.message)) {
      throw new Error('这份资料已经存在；如有修改，请选择新版本文件');
    }
    throw error;
  }

  const row = await db.getFirstAsync<SourceItemRow>(
    `${sourceItemSelect} WHERE item.id = ?`,
    itemId,
  );
  if (!row) throw new Error('资料保存后无法读取');
  return mapSourceItem(row);
}

export type SharedSourceTarget =
  | { kind: 'existing'; nodeId: string }
  | { kind: 'new'; title: string };

/** A received share is only committed after the learner chooses its destination. */
export async function saveSharedSourceToNode(
  db: SQLiteDatabase,
  input: NewSourceItem,
  target: SharedSourceTarget,
) {
  if (!['text', 'markdown', 'web'].includes(input.kind)) throw new Error('这条分享路径只接收文字或链接');
  if (!input.title.trim() || !input.contentHash || !input.segments.length || input.segments.every(segment => !segment.body.trim())) {
    throw new Error('分享内容不完整');
  }
  if (input.byteSize > 8_000_000 || input.byteSize < 0) throw new Error('分享文字超过 8 MB 上限');
  if (target.kind === 'new' && (!target.title.trim() || target.title.trim().length > 160)) {
    throw new Error('节点标题需为 1–160 字符');
  }

  const cleanTitle = input.title.trim().slice(0, 160);
  const now = new Date().toISOString();
  let sourceItemId = '';
  let documentId = '';
  let nodeId = '';
  let reused = false;
  await db.withExclusiveTransactionAsync(async transaction => {
    if (!await transaction.getFirstAsync('SELECT id FROM projects WHERE id = ?', input.projectId)) {
      throw new Error('目标白板不存在');
    }
    if (target.kind === 'existing' && !await transaction.getFirstAsync(
      'SELECT id FROM nodes WHERE id = ? AND project_id = ?', target.nodeId, input.projectId,
    )) throw new Error('所选节点不属于目标白板');

    const existing = await transaction.getFirstAsync<{ id: string; derived_document_id: string }>(
      'SELECT id, derived_document_id FROM source_items WHERE project_id = ? AND content_hash = ? AND kind = ?',
      input.projectId, input.contentHash, input.kind,
    );
    reused = Boolean(existing);
    sourceItemId = existing?.id ?? createId('source');
    documentId = existing?.derived_document_id ?? createId('doc');
    if (!existing) {
      await transaction.runAsync(
        `INSERT INTO documents (id, project_id, path, title, body, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'source', ?, ?)`,
        documentId, input.projectId, `资料/分享-${documentId}.md`, cleanTitle,
        buildSourceDocumentBody(input, cleanTitle), now, now,
      );
      await transaction.runAsync(
        `INSERT INTO source_items (
          id, project_id, kind, title, original_name, media_type, asset_uri, source_url,
          content_hash, byte_size, extraction_status, extraction_error,
          derived_document_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'ready', NULL, ?, ?, ?)`,
        sourceItemId, input.projectId, input.kind, cleanTitle, input.originalName,
        input.mediaType, input.sourceUrl, input.contentHash, input.byteSize, documentId, now, now,
      );
      for (const [index, segment] of input.segments.entries()) {
        await transaction.runAsync(
          `INSERT INTO source_segments (id, source_item_id, ordinal, locator_type, locator, body, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          createId('segment'), sourceItemId, index, segment.locatorType,
          segment.locator, segment.body.trim(), segment.contentHash,
        );
      }
    }

    if (target.kind === 'existing') {
      nodeId = target.nodeId;
      await transaction.runAsync(
        'INSERT OR IGNORE INTO node_documents (id, node_id, document_id, sort_order) VALUES (?, ?, ?, 1)',
        createId('link'), nodeId, documentId,
      );
    } else {
      const linked = existing && await transaction.getFirstAsync<{ node_id: string }>(
        'SELECT node_id FROM node_documents WHERE document_id = ? ORDER BY sort_order, node_id LIMIT 1', documentId,
      );
      if (linked) {
        nodeId = linked.node_id;
      } else {
        nodeId = createId('node');
        const position = await transaction.getFirstAsync<{ x: number; count: number }>(
          'SELECT COALESCE(MAX(x), 0) AS x, COUNT(*) AS count FROM nodes WHERE project_id = ?', input.projectId,
        );
        await transaction.runAsync(
          `INSERT INTO nodes (id, project_id, title, subtitle, x, y, importance, status, sort_order, document_id)
           VALUES (?, ?, ?, ?, ?, ?, 5, 'learning', NULL, ?)`,
          nodeId, input.projectId, target.title.trim(), '分享资料',
          (position?.x ?? 0) + 320, 40 + ((position?.count ?? 0) % 6) * 130, documentId,
        );
      }
    }
    await transaction.runAsync('UPDATE projects SET updated_at = ? WHERE id = ?', now, input.projectId);
  });
  const source = await db.getFirstAsync<SourceItemRow>(`${sourceItemSelect} WHERE item.id = ?`, sourceItemId);
  if (!source) throw new Error('分享保存后无法读取');
  return { source: mapSourceItem(source), nodeId, documentId, reused };
}

/** A multi-file share commits every source and its common target node, or none of them. */
export async function saveSharedSourcesToNode(
  db: SQLiteDatabase,
  inputs: NewSourceItem[],
  target: SharedSourceTarget,
) {
  if (!inputs.length || inputs.length > 11) throw new Error('一次最多保存 10 个文件和一段分享文字');
  const projectId = inputs[0].projectId;
  for (const input of inputs) {
    if (input.projectId !== projectId || !['text', 'markdown', 'web', 'pdf', 'image'].includes(input.kind)) throw new Error('分享资料所属白板或类型无效');
    if (!input.title.trim() || !input.contentHash || !input.segments.length || input.segments.every(segment => !segment.body.trim())) throw new Error('分享资料缺少可保存的正文');
    const limit = input.kind === 'pdf' ? 32 * 1024 * 1024 : input.kind === 'image' ? 20_000_000 : 8_000_000;
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 0 || input.byteSize > limit) throw new Error('分享资料超过可同步的大小上限');
    if (input.originalName && !input.assetUri) throw new Error('文件原件尚未持久保存');
    if (input.assetUri && (!input.assetUri.startsWith('file://') || /(?:^|\/)\.\.(?:\/|$)/u.test(decodeURIComponent(input.assetUri)))) {
      throw new Error('原始附件必须保存在应用私有目录');
    }
  }
  if (target.kind === 'new' && (!target.title.trim() || target.title.trim().length > 160)) throw new Error('节点标题需为 1–160 字符');

  const now = new Date().toISOString();
  const documentIds: string[] = [];
  const sourceItemIds: string[] = [];
  const reused: boolean[] = [];
  let nodeId = '';
  await db.withExclusiveTransactionAsync(async tx => {
    if (!await tx.getFirstAsync('SELECT id FROM projects WHERE id = ?', projectId)) throw new Error('目标白板不存在');
    if (target.kind === 'existing' && !await tx.getFirstAsync('SELECT id FROM nodes WHERE id = ? AND project_id = ?', target.nodeId, projectId)) {
      throw new Error('所选节点不属于目标白板');
    }
    for (const input of inputs) {
      const existing = await tx.getFirstAsync<{ id: string; derived_document_id: string }>(
        'SELECT id, derived_document_id FROM source_items WHERE project_id = ? AND content_hash = ? AND kind = ?',
        projectId, input.contentHash, input.kind,
      );
      const sourceItemId = existing?.id ?? createId('source');
      const documentId = existing?.derived_document_id ?? createId('doc');
      const title = input.title.trim().slice(0, 160);
      if (!existing) {
        await tx.runAsync(
          `INSERT INTO documents (id, project_id, path, title, body, origin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'source', ?, ?)`,
          documentId, projectId, `资料/分享-${documentId}.md`, title, buildSourceDocumentBody(input, title), now, now,
        );
        await tx.runAsync(
          `INSERT INTO source_items (id, project_id, kind, title, original_name, media_type, asset_uri, source_url,
           content_hash, byte_size, extraction_status, extraction_error, derived_document_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?, ?)`,
          sourceItemId, projectId, input.kind, title, input.originalName, input.mediaType, input.assetUri,
          input.sourceUrl, input.contentHash, input.byteSize, documentId, now, now,
        );
        for (const [index, segment] of input.segments.entries()) {
          await tx.runAsync(
            `INSERT INTO source_segments (id, source_item_id, ordinal, locator_type, locator, body, content_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            createId('segment'), sourceItemId, index, segment.locatorType, segment.locator,
            segment.body.trim(), segment.contentHash,
          );
        }
      }
      sourceItemIds.push(sourceItemId);
      documentIds.push(documentId);
      reused.push(Boolean(existing));
    }

    if (target.kind === 'existing') nodeId = target.nodeId;
    else {
      if (reused.every(Boolean)) {
        const candidates = await tx.getAllAsync<{ node_id: string }>(
          'SELECT node_id FROM node_documents WHERE document_id = ? ORDER BY sort_order, node_id', documentIds[0],
        );
        for (const candidate of candidates) {
          let allLinked = true;
          for (const documentId of documentIds) {
            if (!await tx.getFirstAsync('SELECT 1 FROM node_documents WHERE node_id = ? AND document_id = ?', candidate.node_id, documentId)) {
              allLinked = false;
              break;
            }
          }
          if (allLinked) { nodeId = candidate.node_id; break; }
        }
      }
      if (!nodeId) {
        nodeId = createId('node');
        const position = await tx.getFirstAsync<{ x: number; count: number }>(
          'SELECT COALESCE(MAX(x), 0) AS x, COUNT(*) AS count FROM nodes WHERE project_id = ?', projectId,
        );
        await tx.runAsync(
          `INSERT INTO nodes (id, project_id, title, subtitle, x, y, importance, status, sort_order, document_id)
           VALUES (?, ?, ?, ?, ?, ?, 5, 'learning', NULL, ?)`,
          nodeId, projectId, target.title.trim(), '分享资料',
          (position?.x ?? 0) + 320, 40 + ((position?.count ?? 0) % 6) * 130, documentIds[0],
        );
      }
    }
    for (const documentId of documentIds) {
      await tx.runAsync(
        'INSERT OR IGNORE INTO node_documents (id, node_id, document_id, sort_order) VALUES (?, ?, ?, 1)',
        createId('link'), nodeId, documentId,
      );
    }
    await tx.runAsync('UPDATE projects SET updated_at = ? WHERE id = ?', now, projectId);
  });
  return { projectId, nodeId, documentIds, sourceItemIds, reused };
}

export async function deleteProjectSourceItem(db: SQLiteDatabase, sourceItemId: string) {
  await db.withExclusiveTransactionAsync(async (transaction) => {
  const rich=await transaction.getAllAsync<{body:string}>('SELECT body FROM documents WHERE project_id=(SELECT project_id FROM source_items WHERE id=?)',sourceItemId);
  const source=await transaction.getFirstAsync<{content_hash:string}>('SELECT content_hash FROM source_items WHERE id=?',sourceItemId);
  if(source&&rich.some(doc=>documentAssets(doc.body).some(ref=>ref.sha256===source.content_hash)))throw Error('这份原件被图文或PDF文档引用，请在节点管理中解除挂载；原件仍保留以支持撤销。');
    const row = await transaction.getFirstAsync<{
      project_id: string;
      derived_document_id: string;
    }>('SELECT project_id, derived_document_id FROM source_items WHERE id = ?', sourceItemId);
    if (!row) throw new Error('资料不存在');
    const result = await transaction.runAsync('DELETE FROM source_items WHERE id = ?', sourceItemId);
    if (result.changes !== 1) throw new Error('资料没有删除');
    await transaction.runAsync(
      `DELETE FROM documents
       WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM source_items WHERE derived_document_id = ?)`,
      row.derived_document_id,
      row.derived_document_id,
    );
    await transaction.runAsync(
      'UPDATE projects SET updated_at = ? WHERE id = ?',
      new Date().toISOString(),
      row.project_id,
    );
  });
}

function buildSourceDocumentBody(input: NewSourceItem, title: string) {
  const metadata = [
    `- 类型：${sourceKindLabel(input.kind)}`,
    input.originalName ? `- 原文件：${input.originalName}` : null,
    input.sourceUrl ? `- 网页：${input.sourceUrl}` : null,
    `- 内容指纹：${input.contentHash}`,
  ].filter(Boolean);
  const sections = input.segments.map((segment) => (
    `## ${segment.locator}\n\n${segment.body.trim()}`
  ));
  return [`# ${title}`, metadata.join('\n'), ...sections].join('\n\n');
}

function buildFailedSourceDocumentBody(input: FailedSourceItem, title: string, error: string) {
  return [
    `# ${title}`,
    `- 类型：${sourceKindLabel(input.kind)}`,
    input.originalName ? `- 原文件：${input.originalName}` : null,
    input.sourceUrl ? `- 网页：${input.sourceUrl}` : null,
    `- 内容指纹：${input.contentHash}`,
    '',
    '## 提取状态',
    '',
    `提取失败：${error}`,
    '',
    '这条记录用于保留失败事实和资料版本；它不会进入 AI 上下文。',
  ].filter((line) => line !== null).join('\n');
}

function sourceKindLabel(kind: SourceItemKind) {
  return {
    text: '文字',
    markdown: 'Markdown',
    pdf: 'PDF',
    image: '图片 OCR',
    web: '公开网页',
  }[kind];
}

function mapSourceItem(row: SourceItemRow): SourceItem {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    originalName: row.original_name,
    mediaType: row.media_type,
    assetUri: row.asset_uri,
    sourceUrl: row.source_url,
    contentHash: row.content_hash,
    byteSize: row.byte_size,
    extractionStatus: row.extraction_status,
    extractionError: row.extraction_error,
    derivedDocumentId: row.derived_document_id,
    segmentCount: row.segment_count,
    extractedCharacters: row.extracted_characters,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSourceSegment(row: SourceSegmentRow): SourceSegment {
  return {
    id: row.id,
    sourceItemId: row.source_item_id,
    ordinal: row.ordinal,
    locatorType: row.locator_type,
    locator: row.locator,
    body: row.body,
    contentHash: row.content_hash,
  };
}

function safePath(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || '资料';
}

function compactTimestamp(value: string) {
  return value.replace(/[-:.TZ]/g, '').slice(0, 14);
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
