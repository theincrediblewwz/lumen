import type { SQLiteDatabase } from 'expo-sqlite';

import type { PromptTemplate } from '@/types/domain';

type PromptTemplateRow = {
  id: string;
  title: string;
  body: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export async function listPromptTemplates(db: SQLiteDatabase): Promise<PromptTemplate[]> {
  const rows = await db.getAllAsync<PromptTemplateRow>(
    'SELECT * FROM prompt_templates ORDER BY sort_order, updated_at DESC',
  );
  return rows.map(mapTemplate);
}

export async function getPromptTemplate(db: SQLiteDatabase, id: string): Promise<PromptTemplate | null> {
  const row = await db.getFirstAsync<PromptTemplateRow>('SELECT * FROM prompt_templates WHERE id = ?', id);
  return row ? mapTemplate(row) : null;
}

export async function savePromptTemplate(
  db: SQLiteDatabase,
  input: { id?: string; title: string; body: string },
): Promise<string> {
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) throw new Error('请填写模板名称');
  if (!body) throw new Error('模板内容不能为空');
  if (title.length > 80) throw new Error('模板名称最多 80 个字符');
  if (body.length > 4_000) throw new Error('模板内容最多 4000 个字符');
  const now = new Date().toISOString();
  const id = input.id ?? createId('template');
  await db.withExclusiveTransactionAsync(async (transaction) => {
    if (input.id) {
      const result = await transaction.runAsync(
        'UPDATE prompt_templates SET title = ?, body = ?, updated_at = ? WHERE id = ?',
        title,
        body,
        now,
        id,
      );
      if (result.changes !== 1) throw new Error('模板不存在或已经删除');
    } else {
      const order = await transaction.getFirstAsync<{ next_order: number }>(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM prompt_templates',
      );
      await transaction.runAsync(
        'INSERT INTO prompt_templates (id, title, body, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        title,
        body,
        order?.next_order ?? 0,
        now,
        now,
      );
    }
  });
  return id;
}

export async function deletePromptTemplate(db: SQLiteDatabase, id: string) {
  await db.runAsync('DELETE FROM prompt_templates WHERE id = ?', id);
}

function mapTemplate(row: PromptTemplateRow): PromptTemplate {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    order: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
