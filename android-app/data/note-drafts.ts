import type { SQLiteDatabase } from 'expo-sqlite';
import { getConversation, listMessages, newLocalId, insertManualEdge, type ConversationMessage, type SavedConversationDocument } from './conversations';

export type NoteSource = Pick<ConversationMessage, 'id' | 'role' | 'body' | 'status' | 'ordinal'>;
export type NoteDraft = {
  id: string; conversation_id: string; message_ids_json: string; source_snapshot_json: string;
  title: string; body: string; parent_node_id: string | null; generation: 'manual' | 'ai';
  status: 'editing' | 'generating' | 'interrupted' | 'saved'; saved_document_id: string | null;
  created_at: string; updated_at: string;
};

function selectedMessages(all: ConversationMessage[], ids: string[]): NoteSource[] {
  const requested = new Set(ids);
  const selected = all.filter(message => requested.has(message.id));
  if (!selected.length || selected.length !== requested.size) throw new Error('所选消息不存在或不属于当前对话');
  if (selected.some(message => message.status === 'pending' || !message.body.trim())) throw new Error('请等待回答完成后再整理');
  return selected.map(({ id, role, body, status, ordinal }) => ({ id, role, body, status, ordinal }));
}

export function noteSources(draft: NoteDraft): NoteSource[] { return JSON.parse(draft.source_snapshot_json) as NoteSource[]; }

export function organizationMessages(draft: NoteDraft) {
  const sources = noteSources(draft);
  const input = sources.map((message, index) => `### 消息 ${index + 1} · ${message.role === 'user' ? '学习者' : 'AI'}${message.status === 'interrupted' ? '（未完成）' : ''}\n${message.body}`).join('\n\n');
  const messages = [
    { role: 'system' as const, content: '将学习对话整理成简洁的 Markdown 学习笔记。只依据所给消息；不要编造事实、引文或来源。按需使用“核心结论”“必要解释”“例子”“尚未解决的问题”标题，空节省略。区分讨论原文中的说法与你的推断；不确定处明确说明。只输出笔记正文。' },
    { role: 'user' as const, content: input },
  ];
  if (JSON.stringify(messages).length > 100000) throw new Error('所选内容超过 AI 整理上限，请缩小选择；手动编辑仍可使用');
  return { messages, preview: messages.map(message => `## ${message.role}\n\n${message.content}`).join('\n\n') };
}

export async function getNoteDraft(db: SQLiteDatabase, id: string) {
  return db.getFirstAsync<NoteDraft>('SELECT * FROM note_drafts WHERE id=?', id);
}

export async function openNoteDraft(db: SQLiteDatabase, conversationId: string, messageIds: string[], fresh = false) {
  let result!: NoteDraft;
  await db.withExclusiveTransactionAsync(async tx => {
    const conversation = await getConversation(tx, conversationId);
    if (!conversation) throw new Error('原对话不存在');
    const selected = selectedMessages(await listMessages(tx, conversationId), messageIds);
    const ids = selected.map(message => message.id);
    if (!fresh) {
      const drafts = await tx.getAllAsync<NoteDraft>("SELECT * FROM note_drafts WHERE conversation_id=? AND status!='saved' ORDER BY updated_at DESC", conversationId);
      const existing = drafts.find(draft => draft.message_ids_json === JSON.stringify(ids));
      if (existing) { result = existing; return; }
    }
    const snapshot = JSON.stringify(selected);
    if (snapshot.length > 1000000) throw new Error('所选内容超过草稿上限，请缩小选择范围');
    const now = new Date().toISOString();
    const id = newLocalId('note-draft');
    const firstQuestion = selected.find(message => message.role === 'user')?.body ?? conversation.title;
    const title = firstQuestion.replace(/\s+/gu, ' ').slice(0, 100) || '学习笔记';
    await tx.runAsync('INSERT INTO note_drafts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', id, conversationId, JSON.stringify(ids), snapshot, title, '', conversation.node_id, 'manual', 'editing', null, now, now);
    result = (await getNoteDraft(tx, id))!;
  });
  return result;
}

export async function updateNoteDraft(db: SQLiteDatabase, id: string, input: { title: string; body: string; parentNodeId: string | null }) {
  if (input.title.length > 160 || input.body.length > 1000000) throw new Error('标题或正文超过保存上限');
  const result = await db.runAsync("UPDATE note_drafts SET title=?,body=?,parent_node_id=?,updated_at=? WHERE id=? AND status!='saved' AND status!='generating'", input.title, input.body, input.parentNodeId, new Date().toISOString(), id);
  if (!result.changes) throw new Error('草稿已保存或正在生成，请重新打开');
}

export async function setNoteGeneration(db: SQLiteDatabase, id: string, status: 'generating' | 'editing' | 'interrupted', body?: string) {
  const result = await db.runAsync("UPDATE note_drafts SET status=?,generation='ai',body=COALESCE(?,body),updated_at=? WHERE id=? AND status!='saved'", status, body ?? null, new Date().toISOString(), id);
  if (!result.changes) throw new Error('草稿已保存，无法再次整理');
}

export async function saveOrganizedNoteAsNode(db: SQLiteDatabase, draftId: string): Promise<SavedConversationDocument> {
  let result!: SavedConversationDocument;
  await db.withExclusiveTransactionAsync(async tx => {
    const draft = await getNoteDraft(tx, draftId);
    if (!draft) throw new Error('草稿不存在');
    const key = `note:v1:${draft.id}`;
    const existing = await tx.getFirstAsync<{ document_id: string; node_id: string | null; project_id: string }>(
      'SELECT c.document_id,c.node_id,d.project_id FROM conversation_documents c JOIN documents d ON d.id=c.document_id WHERE c.selection_key=?', key);
    if (existing) { result = { documentId: existing.document_id, nodeId: existing.node_id, projectId: existing.project_id, reused: true }; return; }
    const title = draft.title.trim(); const body = draft.body.trim();
    if (!title || title.length > 160) throw new Error('请填写 1–160 字符的笔记标题');
    if (!body || body.length > 1000000) throw new Error('请填写不超过 100 万字符的笔记正文');
    if (draft.status === 'generating') throw new Error('请先停止整理再保存');
    const conversation = await getConversation(tx, draft.conversation_id);
    if (!conversation) throw new Error('原对话不存在');
    const ids = JSON.parse(draft.message_ids_json) as string[];
    const selected = selectedMessages(await listMessages(tx, conversation.id), ids);
    if (JSON.stringify(selected) !== draft.source_snapshot_json) throw new Error('来源消息已变化；草稿仍保留，请重新选取来源');
    const parent = draft.parent_node_id ? await tx.getFirstAsync<{ x: number; y: number }>('SELECT x,y FROM nodes WHERE id=? AND project_id=?', draft.parent_node_id, conversation.project_id) : null;
    if (draft.parent_node_id && !parent) throw new Error('所选连接节点已不存在，请重新选择');
    const now = new Date().toISOString(); const documentId = newLocalId('doc'); const nodeId = newLocalId('node');
    const count = await tx.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM nodes WHERE project_id=?', conversation.project_id);
    await tx.runAsync('INSERT INTO documents (id,project_id,path,title,body,origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', documentId, conversation.project_id, `笔记/${documentId}.md`, title, body, draft.generation === 'ai' ? 'ai' : 'learner', now, now);
    await tx.runAsync('INSERT INTO nodes (id,project_id,title,subtitle,x,y,importance,status,sort_order,document_id) VALUES (?,?,?,?,?,?,?,?,?,?)', nodeId, conversation.project_id, title, '学习笔记', (parent?.x ?? 0) + 320, (parent?.y ?? 40) + (count?.n ?? 0) % 6 * 130, 5, 'learning', null, documentId);
    if (draft.parent_node_id) await insertManualEdge(tx, conversation.project_id, draft.parent_node_id, nodeId, 'followup', '从讨论整理');
    await tx.runAsync('INSERT INTO conversation_documents VALUES (?,?,?,?,?,?,?,?)', newLocalId('capture'), conversation.id, null, documentId, nodeId, JSON.stringify(ids), key, now);
    await tx.runAsync("UPDATE note_drafts SET status='saved',saved_document_id=?,updated_at=? WHERE id=?", documentId, now, draft.id);
    await tx.runAsync('UPDATE projects SET updated_at=? WHERE id=?', now, conversation.project_id);
    result = { documentId, nodeId, projectId: conversation.project_id, reused: false };
  });
  return result;
}
