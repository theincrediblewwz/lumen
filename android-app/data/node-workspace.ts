import type { SQLiteDatabase } from 'expo-sqlite';
import { insertManualEdge, newLocalId } from './conversations';
import type { MarkdownDocument } from '@/types/domain';

export async function listNodeDocuments(db: SQLiteDatabase, nodeId: string): Promise<MarkdownDocument[]> {
  return db.getAllAsync<MarkdownDocument>(`SELECT d.id,d.project_id AS projectId,d.path,d.title,d.body,d.origin,d.created_at AS createdAt,d.updated_at AS updatedAt
    FROM node_documents l JOIN documents d ON d.id=l.document_id WHERE l.node_id=? ORDER BY l.sort_order,l.id`,nodeId);
}
export async function createManualNode(db:SQLiteDatabase,input:{projectId:string;title:string;body:string;parentId?:string}) {
  if (!input.title.trim() || input.title.length>160 || input.body.length>1000000) throw new Error('标题需为 1–160 字符，正文最多 100 万字符');
  const id=newLocalId('node'); const doc=newLocalId('doc'); const now=new Date().toISOString();
  await db.withExclusiveTransactionAsync(async tx=>{
    const parent=input.parentId ? await tx.getFirstAsync<{x:number;y:number}>('SELECT x,y FROM nodes WHERE id=? AND project_id=?',input.parentId,input.projectId):null;
    if (input.parentId && !parent) throw new Error('父节点不存在');
    const count=await tx.getFirstAsync<{n:number}>('SELECT COUNT(*) AS n FROM nodes WHERE project_id=?',input.projectId);
    await tx.runAsync('INSERT INTO documents (id,project_id,path,title,body,origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',doc,input.projectId,`笔记/${doc}.md`,input.title.trim(),input.body,'learner',now,now);
    await tx.runAsync('INSERT INTO nodes (id,project_id,title,subtitle,x,y,importance,status,sort_order,document_id) VALUES (?,?,?,?,?,?,?,?,?,?)',id,input.projectId,input.title.trim(),'我的笔记',(parent?.x??0)+320,(parent?.y??40)+(count?.n??0)%6*130,5,'learning',null,doc);
    if (input.parentId) await insertManualEdge(tx,input.projectId,input.parentId,id,'followup','追问');
    await tx.runAsync('UPDATE projects SET updated_at=? WHERE id=?',now,input.projectId);
  });
  return id;
}
export async function addNodeDocument(db:SQLiteDatabase,nodeId:string,title:string,body:string) {
  if (!title.trim()||title.length>160||body.length>1000000) throw new Error('标题或正文超出上限');
  const id=newLocalId('doc'); const now=new Date().toISOString();
  await db.withExclusiveTransactionAsync(async tx=>{
    const node=await tx.getFirstAsync<{project_id:string}>('SELECT project_id FROM nodes WHERE id=?',nodeId);
    if (!node) throw new Error('节点不存在');
    await tx.runAsync('INSERT INTO documents (id,project_id,path,title,body,origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',id,node.project_id,`笔记/${id}.md`,title.trim(),body,'learner',now,now);
    await tx.runAsync('INSERT INTO node_documents VALUES (?,?,?,?)',newLocalId('link'),nodeId,id,1);
    await tx.runAsync('UPDATE projects SET updated_at=? WHERE id=?',now,node.project_id);
  });
  return id;
}
export async function connectNodes(db:SQLiteDatabase,projectId:string,from:string,to:string) {
  await db.withExclusiveTransactionAsync(async tx=>{await insertManualEdge(tx,projectId,from,to,'related','相关');});
}
export async function moveNode(db:SQLiteDatabase,id:string,x:number,y:number) {
  if (![x,y].every(n=>Number.isFinite(n)&&Math.abs(n)<1000000)) throw new Error('节点位置无效');
  await db.runAsync('UPDATE nodes SET x=?,y=? WHERE id=?',x,y,id);
}
export async function saveDocumentRevision(db:SQLiteDatabase,id:string,body:string,expectedUpdatedAt:string,expectedBody:string) {
  if (body.length>1000000) throw new Error('正文超过保存上限');
  const updatedAt=new Date().toISOString();
  // Wall clocks can collide locally or arrive unchanged from another device.
  // Compare the actual edit baseline as well, in the same atomic UPDATE.
  const result=await db.runAsync("UPDATE documents SET body=?,origin='learner',updated_at=? WHERE id=? AND updated_at=? AND body=?",body,updatedAt,id,expectedUpdatedAt,expectedBody);
  if (result.changes!==1) throw new Error('这篇文档已在别处更新。你的编辑仍在此页，请复制保留后重新打开文档比较。');
  return updatedAt;
}
export async function getDocumentDiscussion(db:SQLiteDatabase,id:string) {
  return db.getFirstAsync<{conversation_id:string|null;source_answer_id:string|null;node_id:string|null}>('SELECT conversation_id,source_answer_id,node_id FROM conversation_documents WHERE document_id=?',id);
}

export async function createFreeBoard(db: SQLiteDatabase, title: string, body: string) {
  if (!title.trim() || title.length > 160 || body.length > 1000000) throw new Error('标题或正文超出上限');
  const projectId = newLocalId('project'); const nodeId = newLocalId('node'); const documentId = newLocalId('doc');
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async tx => {
    await tx.runAsync("INSERT INTO projects(id,title,created_at,updated_at,graph_kind) VALUES(?,?,?,?,'free')",projectId,title.trim(),now,now);
    await tx.runAsync("INSERT INTO documents(id,project_id,path,title,body,origin,created_at,updated_at) VALUES(?,?,?,?,?,'learner',?,?)",documentId,projectId,`笔记/${documentId}.md`,title.trim(),body,now,now);
    await tx.runAsync("INSERT INTO nodes(id,project_id,title,x,y,importance,status,document_id) VALUES(?,?,?,0,0,5,'learning',?)",nodeId,projectId,title.trim(),documentId);
  });
  return {projectId,nodeId};
}

export async function attachDocument(db:SQLiteDatabase,nodeId:string,documentId:string) {
  await db.withExclusiveTransactionAsync(async tx => {
    const pair=await tx.getFirstAsync('SELECT 1 FROM nodes n JOIN documents d ON n.project_id=d.project_id WHERE n.id=? AND d.id=?',nodeId,documentId);
    if (!pair) throw new Error('只能挂载当前图谱中的文档');
    await tx.runAsync('INSERT OR IGNORE INTO node_documents(id,node_id,document_id,sort_order) VALUES(?,?,?,1)',newLocalId('link'),nodeId,documentId);
  });
}

export async function detachDocument(db:SQLiteDatabase,nodeId:string,documentId:string) {
  await db.withExclusiveTransactionAsync(async tx => {
    const node=await tx.getFirstAsync<{document_id:string}>('SELECT document_id FROM nodes WHERE id=?',nodeId);
    if (!node) throw new Error('节点不存在');
    if (node.document_id===documentId) throw new Error('请先将另一篇文档设为主文档');
    await tx.runAsync('DELETE FROM node_documents WHERE node_id=? AND document_id=?',nodeId,documentId);
  });
}
