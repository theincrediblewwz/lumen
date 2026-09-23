import type { SQLiteDatabase } from 'expo-sqlite';
import { parseReadingQuestion, READING_QUESTION_LIMIT } from './reading-reference';

export type Conversation = { id: string; project_id: string; node_id: string | null; title: string; created_at: string; updated_at: string };
export type ConversationMessage = {
  id: string; conversation_id: string; role: 'user' | 'assistant'; body: string;
  status: 'pending' | 'complete' | 'interrupted' | 'failed'; ordinal: number;
  request_id: string | null; actual_model: string | null; created_at: string; updated_at: string;
};
export type SavedConversationDocument = { documentId: string; nodeId: string | null; projectId: string; reused: boolean };
export function newLocalId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

export async function listConversations(db: SQLiteDatabase, projectId: string, nodeId?: string) {
  return nodeId
    ? db.getAllAsync<Conversation>('SELECT * FROM conversations WHERE project_id=? AND node_id=? ORDER BY updated_at DESC', projectId, nodeId)
    : db.getAllAsync<Conversation>('SELECT * FROM conversations WHERE project_id=? ORDER BY updated_at DESC', projectId);
}
export async function createConversation(db: SQLiteDatabase, projectId: string, nodeId: string | null, title: string) {
  const id = newLocalId('chat'); const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async tx => {
    if (nodeId && !await tx.getFirstAsync('SELECT id FROM nodes WHERE id=? AND project_id=?', nodeId, projectId)) throw new Error('节点不属于当前白板');
    await tx.runAsync('INSERT INTO conversations VALUES (?,?,?,?,?,?)', id, projectId, nodeId, title.trim().slice(0,160) || '新的讨论', now, now);
  });
  return id;
}
export async function getConversation(db: SQLiteDatabase, id: string) { return db.getFirstAsync<Conversation>('SELECT * FROM conversations WHERE id=?', id); }
export async function listMessages(db: SQLiteDatabase, id: string) { return db.getAllAsync<ConversationMessage>('SELECT * FROM conversation_messages WHERE conversation_id=? ORDER BY ordinal,created_at,id', id); }

export async function beginConversationTurn(db: SQLiteDatabase, conversationId: string, question: string) {
  const reading = parseReadingQuestion(question);
  if (!question.trim() || question.length > (reading ? READING_QUESTION_LIMIT : 12000)) throw new Error('问题需要填写，且不能超过 12000 字符（引用资料另计）');
  const userId = newLocalId('msg'); const assistantId = newLocalId('msg'); const requestId = newLocalId('request');
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async tx => {
    const conversation = await getConversation(tx, conversationId);
    if (!conversation) throw new Error('原对话不存在');
    if (reading && reading.reference.projectId !== conversation.project_id) throw new Error('引用资料不属于当前白板');
    if (await tx.getFirstAsync("SELECT id FROM conversation_messages WHERE conversation_id=? AND status='pending'", conversationId)) throw new Error('请先等待当前回答完成或停止生成');
    const next = (await tx.getFirstAsync<{ n: number }>('SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM conversation_messages WHERE conversation_id=?', conversationId))!.n;
    await tx.runAsync('INSERT INTO conversation_messages VALUES (?,?,?,?,?,?,?,?,?,?)', userId, conversationId, 'user', question, 'complete', next, requestId, null, now, now);
    await tx.runAsync('INSERT INTO conversation_messages VALUES (?,?,?,?,?,?,?,?,?,?)', assistantId, conversationId, 'assistant', '', 'pending', next+1, requestId, null, now, now);
    await tx.runAsync('UPDATE conversations SET updated_at=? WHERE id=?', now, conversationId);
  });
  return { userId, assistantId, requestId };
}
export async function updateConversationReply(db: SQLiteDatabase, id: string, body: string, status: ConversationMessage['status'], model: string | null) {
  if (body.length > 1000000) throw new Error('回答超过本地保存上限');
  await db.runAsync("UPDATE conversation_messages SET body=?,status=?,actual_model=?,updated_at=? WHERE id=? AND role='assistant' AND status='pending'", body, status, model, new Date().toISOString(), id);
}

export function conversationMarkdown(messages: ConversationMessage[]) {
  return messages.map(m => `## ${m.role === 'user' ? '我' : 'AI'}\n\n${m.body}${m.status !== 'complete' ? '\n\n> 这条回答在完成前中断，保留的是已收到的原文。' : ''}`).join('\n\n---\n\n');
}

/** Source selection is read inside the same transaction that creates the document and node. */
export async function saveDiscussionAsNode(db: SQLiteDatabase, input: {
  title: string; conversationId?: string; messageIds?: string[]; answerId?: string;
}): Promise<SavedConversationDocument> {
  const title = input.title.trim();
  if (!title || title.length > 160) throw new Error('请填写 1–160 字符的节点标题');
  if (Boolean(input.answerId) === Boolean(input.conversationId)) throw new Error('请选择一段对话或一条回答');
  let result!: SavedConversationDocument;
  await db.withExclusiveTransactionAsync(async tx => {
    let projectId: string; let parentId: string | null; let body: string; let selectionKey: string; let selectedIds: string[] = [];
    if (input.answerId) {
      const answer = await tx.getFirstAsync<{ project_id: string; node_id: string; question: string; body: string }>('SELECT * FROM node_answers WHERE id=?', input.answerId);
      if (!answer) throw new Error('原回答不存在');
      projectId=answer.project_id; parentId=answer.node_id;
      body=`## 我\n\n${answer.question}\n\n## AI\n\n${answer.body}`;
      selectionKey=`answer:${input.answerId}`;
    } else {
      const conversation = await getConversation(tx, input.conversationId!);
      if (!conversation) throw new Error('原对话不存在');
      const all = await listMessages(tx, conversation.id);
      const requested = new Set(input.messageIds ?? all.map(m => m.id));
      const selected = all.filter(m => requested.has(m.id));
      if (!selected.length || selected.length !== requested.size) throw new Error('所选消息不存在或不属于当前对话');
      if (selected.some(m => m.status === 'pending' || !m.body.trim())) throw new Error('请等待回答完成或停止生成后再保存');
      selectedIds = selected.map(m => m.id);
      projectId=conversation.project_id; parentId=conversation.node_id; body=conversationMarkdown(selected);
      selectionKey=`chat:${conversation.id}:${selectedIds.join(',')}`;
    }
    const existing = await tx.getFirstAsync<{ document_id: string; node_id: string | null }>('SELECT document_id,node_id FROM conversation_documents WHERE selection_key=?', selectionKey);
    if (existing) { result={documentId:existing.document_id,nodeId:existing.node_id,projectId,reused:true}; return; }
    if (body.length > 1000000) throw new Error('所选内容超过单篇文档上限，请缩小选择范围');
    const parent = parentId ? await tx.getFirstAsync<{ x:number;y:number }>('SELECT x,y FROM nodes WHERE id=? AND project_id=?',parentId,projectId) : null;
    if (!parent) parentId=null;
    const now=new Date().toISOString(); const documentId=newLocalId('doc'); const nodeId=newLocalId('node');
    const siblings=await tx.getFirstAsync<{ n:number }>('SELECT COUNT(*) AS n FROM nodes WHERE project_id=?',projectId);
    const x=(parent?.x ?? 0)+320; const y=(parent?.y ?? 40)+(siblings?.n ?? 0)%6*130;
    await tx.runAsync('INSERT INTO documents (id,project_id,path,title,body,origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',documentId,projectId,`讨论/${documentId}.md`,title,body,'ai',now,now);
    await tx.runAsync('INSERT INTO nodes (id,project_id,title,subtitle,x,y,importance,status,sort_order,document_id) VALUES (?,?,?,?,?,?,?,?,?,?)',nodeId,projectId,title,'从对话保存',x,y,5,'learning',null,documentId);
    if (parentId) await insertManualEdge(tx,projectId,parentId,nodeId,'followup','从对话延伸');
    if (input.answerId) {
      const citations = await tx.getAllAsync<{ source_item_id: string; locator: string; quote: string }>(
        "SELECT source_item_id,locator,quote FROM source_citations WHERE target_type='answer' AND target_id=? AND project_id=? ORDER BY id", input.answerId, projectId,
      );
      for (const citation of citations) for (const [targetType, targetId] of [['document', documentId], ['node', nodeId]]) {
        await tx.runAsync('INSERT INTO source_citations (id,project_id,target_type,target_id,source_item_id,locator,quote,created_at) VALUES (?,?,?,?,?,?,?,?)',
          newLocalId('citation'), projectId, targetType, targetId, citation.source_item_id, citation.locator, citation.quote, now);
      }
    }
    await tx.runAsync('INSERT INTO conversation_documents VALUES (?,?,?,?,?,?,?,?)',newLocalId('capture'),input.conversationId ?? null,input.answerId ?? null,documentId,nodeId,JSON.stringify(selectedIds),selectionKey,now);
    await tx.runAsync('UPDATE projects SET updated_at=? WHERE id=?',now,projectId);
    result={documentId,nodeId,projectId,reused:false};
  });
  return result;
}

export async function insertManualEdge(tx: SQLiteDatabase, projectId:string, from:string, to:string, kind:'related'|'followup', label='') {
  if (from === to) throw new Error('请选择另一个节点');
  for (const id of [from,to]) if (!await tx.getFirstAsync('SELECT id FROM nodes WHERE id=? AND project_id=?',id,projectId)) throw new Error('只能连接同一白板的节点');
  const id=newLocalId('edge'); const doc=newLocalId('doc'); const now=new Date().toISOString();
  await tx.runAsync('INSERT INTO documents (id,project_id,path,title,body,origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',doc,projectId,`关系/${id}.md`,label || '关联说明',label || '由你建立的关联。','learner',now,now);
  await tx.runAsync("INSERT INTO edges (id,project_id,source_id,target_id,relation,importance,document_id,review_status,relation_kind,directed,label) VALUES (?,?,?,?,'support',5,?,'unverified',?,?,?)",id,projectId,from,to,doc,kind,kind==='followup'?1:0,label);
  return id;
}
