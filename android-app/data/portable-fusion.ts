import {remapFormalLinks} from './formal-links';
import type { SQLiteDatabase } from 'expo-sqlite';
import { remapReadingReferences } from './reading-reference';
import type { Conversation, ConversationMessage } from './conversations';

type Link = { id: string; node_id: string; document_id: string; sort_order: number };
type Provenance = { id: string; conversation_id: string | null; source_answer_id: string | null; document_id: string; node_id: string | null; message_ids_json: string; selection_key: string; created_at: string };
type Position = { id: string; document_id: string; anchor: string; ratio: number; updated_at: string };
type EdgePresentation = { id: string; relation_kind: string | null; directed: number; label: string };
type PortableCanvasGroup = { id: string; title: string; created_at: string; updated_at: string };
type PortableCanvasMember = { id: string; group_id: string; node_id: string; created_at: string };
export type PortableFusion = {
  graphKind: 'free' | 'learning' | 'summary'; nodeDocuments: Link[];
  conversations: Omit<Conversation, 'project_id'>[]; messages: ConversationMessage[];
  conversationDocuments: Provenance[]; readingPositions: Position[]; edgePresentation: EdgePresentation[];
  canvasGroups?: PortableCanvasGroup[]; canvasGroupMembers?: PortableCanvasMember[];
};

export async function exportPortableFusion(db: SQLiteDatabase, projectId: string): Promise<PortableFusion> {
  const project = await db.getFirstAsync<{ graph_kind: PortableFusion['graphKind'] }>('SELECT graph_kind FROM projects WHERE id=?', projectId);
  const [nodeDocuments, conversations, messages, conversationDocuments, readingPositions, edgePresentation, canvasGroups, canvasGroupMembers] = await Promise.all([
    db.getAllAsync<Link>('SELECT d.* FROM node_documents d JOIN nodes n ON n.id=d.node_id WHERE n.project_id=? ORDER BY d.id', projectId),
    db.getAllAsync<Omit<Conversation, 'project_id'>>('SELECT id,node_id,title,created_at,updated_at FROM conversations WHERE project_id=? ORDER BY id', projectId),
    db.getAllAsync<ConversationMessage>('SELECT m.* FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.project_id=? ORDER BY m.conversation_id,m.ordinal,m.id', projectId),
    db.getAllAsync<Provenance>('SELECT p.* FROM conversation_documents p JOIN documents d ON d.id=p.document_id WHERE d.project_id=? ORDER BY p.id', projectId),
    db.getAllAsync<Position>('SELECT r.* FROM reading_positions r JOIN documents d ON d.id=r.document_id WHERE d.project_id=? ORDER BY r.id', projectId),
    db.getAllAsync<EdgePresentation>('SELECT id,relation_kind,directed,label FROM edges WHERE project_id=? ORDER BY id', projectId),
    db.getAllAsync<PortableCanvasGroup>('SELECT id,title,created_at,updated_at FROM canvas_groups WHERE project_id=? ORDER BY id', projectId),
    db.getAllAsync<PortableCanvasMember>('SELECT id,group_id,node_id,created_at FROM canvas_group_members WHERE project_id=? ORDER BY id', projectId),
  ]);
  return { graphKind: project?.graph_kind ?? 'learning', nodeDocuments, conversations, messages, conversationDocuments, readingPositions, edgePresentation, canvasGroups, canvasGroupMembers };
}

function obj(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('对话与阅读资料格式错误');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 512, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > max) throw new Error('对话与阅读资料字段无效');
  return value;
}
function nullable(value: unknown) { return value === null ? null : text(value); }
function num(value: unknown, min: number, max: number, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error('对话与阅读资料数值无效');
  return value;
}
function rows(value: unknown, limit = 20000): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('对话与阅读资料缺少完整列表或超过上限');
  return value.map(obj);
}
function unique(items: { id: string }[]) {
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('对话与阅读资料存在重复 ID');
}
function referenced(set: Set<string>, id: string | null) { if (id !== null && !set.has(id)) throw new Error('对话与阅读资料引用不存在或属于其他图谱'); }

export function validatePortableFusion(value: unknown, refs: { nodes: Set<string>; documents: Set<string>; answers: Set<string>; edges: Set<string> }): PortableFusion {
  const root = obj(value);
  if (!['free', 'learning', 'summary'].includes(String(root.graphKind))) throw new Error('图谱类型无效');
  const nodeDocuments = rows(root.nodeDocuments).map((r): Link => ({ id: text(r.id), node_id: text(r.node_id), document_id: text(r.document_id), sort_order: num(r.sort_order, -1e6, 1e6, true) }));
  const conversations = rows(root.conversations, 5000).map((r): Omit<Conversation, 'project_id'> => ({ id: text(r.id), node_id: nullable(r.node_id), title: text(r.title, 1000), created_at: text(r.created_at, 80), updated_at: text(r.updated_at, 80) }));
  const messages = rows(root.messages).map((r): ConversationMessage => {
    if (!['user', 'assistant'].includes(String(r.role)) || !['pending', 'complete', 'interrupted', 'failed'].includes(String(r.status))) throw new Error('对话消息角色或状态无效');
    return { id: text(r.id), conversation_id: text(r.conversation_id), role: r.role as ConversationMessage['role'], body: text(r.body, 1000000, true), status: r.status as ConversationMessage['status'], ordinal: num(r.ordinal, 0, 1e9, true), request_id: nullable(r.request_id), actual_model: nullable(r.actual_model), created_at: text(r.created_at, 80), updated_at: text(r.updated_at, 80) };
  });
  const conversationDocuments = rows(root.conversationDocuments).map((r): Provenance => ({ id: text(r.id), conversation_id: nullable(r.conversation_id), source_answer_id: nullable(r.source_answer_id), document_id: text(r.document_id), node_id: nullable(r.node_id), message_ids_json: text(r.message_ids_json, 1000000), selection_key: text(r.selection_key, 1000000), created_at: text(r.created_at, 80) }));
  const readingPositions = rows(root.readingPositions).map((r): Position => ({ id: text(r.id), document_id: text(r.document_id), anchor: text(r.anchor, 4000, true), ratio: num(r.ratio, 0, 1), updated_at: text(r.updated_at, 80) }));
  const edgePresentation = rows(root.edgePresentation).map((r): EdgePresentation => ({ id: text(r.id), relation_kind: nullable(r.relation_kind), directed: num(r.directed, 0, 1, true), label: text(r.label, 4000, true) }));
  const canvasGroups = rows(root.canvasGroups ?? []).map((r): PortableCanvasGroup => ({ id: text(r.id), title: text(r.title, 80), created_at: text(r.created_at, 80), updated_at: text(r.updated_at, 80) }));
  const canvasGroupMembers = rows(root.canvasGroupMembers ?? []).map((r): PortableCanvasMember => ({ id: text(r.id), group_id: text(r.group_id), node_id: text(r.node_id), created_at: text(r.created_at, 80) }));
  for (const list of [nodeDocuments, conversations, messages, conversationDocuments, readingPositions, edgePresentation, canvasGroups, canvasGroupMembers]) unique(list);
  if (edgePresentation.length !== refs.edges.size || [...refs.nodes].some((id) => !nodeDocuments.some((link) => link.node_id === id))) throw new Error('图谱清单缺少边设置或节点文档绑定');
  if (new Set(readingPositions.map((item) => item.document_id)).size !== readingPositions.length) throw new Error('同一文档的阅读位置重复');
  if (new Set(nodeDocuments.map((r) => JSON.stringify([r.node_id, r.document_id]))).size !== nodeDocuments.length) throw new Error('节点文档绑定重复');
  if (new Set(conversationDocuments.map((r) => r.selection_key)).size !== conversationDocuments.length) throw new Error('保存对话的来源标识重复');
  const conversationIds = new Set(conversations.map((r) => r.id)); const messageById = new Map(messages.map((r) => [r.id, r]));
  for (const link of nodeDocuments) { referenced(refs.nodes, link.node_id); referenced(refs.documents, link.document_id); }
  for (const conversation of conversations) referenced(refs.nodes, conversation.node_id);
  for (const message of messages) referenced(conversationIds, message.conversation_id);
  for (const saved of conversationDocuments) {
    referenced(conversationIds, saved.conversation_id); referenced(refs.answers, saved.source_answer_id); referenced(refs.nodes, saved.node_id); referenced(refs.documents, saved.document_id);
    let ids: unknown; try { ids = JSON.parse(saved.message_ids_json); } catch { throw new Error('保存对话的消息来源格式错误'); }
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || (saved.conversation_id !== null && (!messageById.has(id) || messageById.get(id)!.conversation_id !== saved.conversation_id)))) throw new Error('保存文档的来源消息不存在或不属于该对话');
  }
  for (const position of readingPositions) referenced(refs.documents, position.document_id);
  for (const edge of edgePresentation) referenced(refs.edges, edge.id);
  const groupIds = new Set(canvasGroups.map(group => group.id));
  for (const member of canvasGroupMembers) {
    if (member.id !== member.node_id) throw new Error('分组成员标识与节点不一致');
    referenced(groupIds, member.group_id); referenced(refs.nodes, member.node_id);
  }
  if (canvasGroupMembers.length && canvasGroups.length === 0) throw new Error('分组成员缺少分组');
  if (messages.reduce((sum, r) => sum + r.body.length, 0) > 12000000) throw new Error('对话内容超过 12 MB 上限');
  return { graphKind: root.graphKind as PortableFusion['graphKind'], nodeDocuments, conversations, messages, conversationDocuments, readingPositions, edgePresentation, canvasGroups, canvasGroupMembers };
}

export async function importPortableFusion(tx: SQLiteDatabase, fusion: PortableFusion | undefined, map: { projectId: string; sourceProjectId: string; documentIds: Map<string, string>; nodeIds: Map<string, string>; answerIds: Map<string, string>; edgeIds: Map<string, string>;conversationIds?:Map<string,string>;messageIds?:Map<string,string> }, id: (prefix: string) => string) {
  if (!fusion) return;
  const conversations = map.conversationIds ?? new Map(fusion.conversations.map((r) => [r.id, id('chat')]));
  const messages = map.messageIds ?? new Map(fusion.messages.map((r) => [r.id, id('msg')]));
  await tx.runAsync('UPDATE projects SET graph_kind=? WHERE id=?', fusion.graphKind, map.projectId);
  for (const edge of fusion.edgePresentation) await tx.runAsync('UPDATE edges SET relation_kind=?,directed=?,label=? WHERE id=?', edge.relation_kind, edge.directed, edge.label, map.edgeIds.get(edge.id)!);
  for (const link of fusion.nodeDocuments) {
    const nodeId = map.nodeIds.get(link.node_id)!; const documentId = map.documentIds.get(link.document_id)!;
    await tx.runAsync('INSERT INTO node_documents(id,node_id,document_id,sort_order) VALUES(?,?,?,?) ON CONFLICT(node_id,document_id) DO UPDATE SET sort_order=excluded.sort_order', `link-${nodeId}-${documentId}`, nodeId, documentId, link.sort_order);
  }
  for (const c of fusion.conversations) await tx.runAsync('INSERT INTO conversations VALUES(?,?,?,?,?,?)', conversations.get(c.id)!, map.projectId, c.node_id ? map.nodeIds.get(c.node_id)! : null, c.title, c.created_at, c.updated_at);
  for (const m of fusion.messages) await tx.runAsync('INSERT INTO conversation_messages VALUES(?,?,?,?,?,?,?,?,?,?)', messages.get(m.id)!, conversations.get(m.conversation_id)!, m.role, remapFormalLinks(remapReadingReferences(m.body, map.sourceProjectId, map.projectId, map.documentIds),new Map([...map.nodeIds,...conversations,...messages]),map.projectId), m.status === 'pending' ? 'interrupted' : m.status, m.ordinal, null, m.actual_model, m.created_at, m.updated_at);
  for (const saved of fusion.conversationDocuments) {
    const conversationId = saved.conversation_id ? conversations.get(saved.conversation_id)! : null;
    const answerId = saved.source_answer_id ? map.answerIds.get(saved.source_answer_id)! : null;
    const messageIds = (JSON.parse(saved.message_ids_json) as string[]).map((oldId) => messages.get(oldId) ?? oldId);
    const selectionKey = saved.selection_key.startsWith('note:v1:')
      ? `note:v1:${map.documentIds.get(saved.document_id)!}`
      : answerId ? `answer:${answerId}` : conversationId ? `chat:${conversationId}:${messageIds.join(',')}` : `import:${id('capture')}`;
    await tx.runAsync('INSERT INTO conversation_documents VALUES(?,?,?,?,?,?,?,?)', id('capture'), conversationId, answerId, map.documentIds.get(saved.document_id)!, saved.node_id ? map.nodeIds.get(saved.node_id)! : null, JSON.stringify(messageIds), selectionKey, saved.created_at);
  }
  for (const r of fusion.readingPositions) {
    const documentId = map.documentIds.get(r.document_id)!;
    await tx.runAsync('INSERT INTO reading_positions VALUES(?,?,?,?,?)', documentId, documentId, r.anchor, r.ratio, r.updated_at);
  }
  const groupIds = new Map((fusion.canvasGroups ?? []).map(group => [group.id, id('group')]));
  for (const group of fusion.canvasGroups ?? []) await tx.runAsync('INSERT INTO canvas_groups VALUES(?,?,?,?,?)', groupIds.get(group.id)!, map.projectId, group.title, group.created_at, group.updated_at);
  for (const member of fusion.canvasGroupMembers ?? []) {
    const nodeId = map.nodeIds.get(member.node_id)!;
    await tx.runAsync('INSERT INTO canvas_group_members VALUES(?,?,?,?,?)', nodeId, map.projectId, groupIds.get(member.group_id)!, nodeId, member.created_at);
  }
}
