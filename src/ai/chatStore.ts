/**
 * AI 对话历史持久化（M5）。
 *
 * 每块白板的对话长期保存在白板文件夹的 chats.json（Tauri 经 Rust 命令读写，
 * 随白板整体复制/迁移）。浏览器预览下回退到 localStorage，方便开发。
 *
 * 数据结构：一块白板可有多个会话（conversation），每个会话是一串消息。
 * 一期 UI 先用「单一当前会话」，但存储结构预留多会话以便日后扩展。
 */

export interface StoredMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  /** 出错的助手消息（不参与后续上下文） */
  error?: boolean;
  /** ISO 时间戳 */
  at: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
  sourceNodeId?: string;
}

export interface ChatsFile {
  version: 1;
  conversations: Conversation[];
}

export const EMPTY_CHATS: ChatsFile = { version: 1, conversations: [] };

/** 宽松解析：容错空串 / 旧结构，永远返回合法 ChatsFile。 */
export function parseChats(raw: string): ChatsFile {
  if (!raw || !raw.trim()) return { version: 1, conversations: [] };
  try {
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.conversations)) {
      return {
        version: 1,
        conversations: j.conversations
          .filter((c: unknown): c is Conversation => !!c && Array.isArray((c as Conversation).messages))
          .map((c: Conversation) => ({
            id: String(c.id ?? newId()),
            title: String(c.title ?? '未命名对话'),
            createdAt: String(c.createdAt ?? new Date().toISOString()),
            updatedAt: String(c.updatedAt ?? new Date().toISOString()),
            sourceNodeId: typeof c.sourceNodeId === "string" ? c.sourceNodeId : undefined,
            messages: (c.messages || []).map((m, index) => ({
              id: m.id ?? `${c.id}_m_${index}`,
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: String(m.content ?? ''),
              error: !!m.error,
              at: String(m.at ?? new Date().toISOString()),
            })),
          })),
      };
    }
  } catch {
    /* 落到空 */
  }
  return { version: 1, conversations: [] };
}

export function serializeChats(chats: ChatsFile): string {
  return JSON.stringify({ version: 1, conversations: chats.conversations }, null, 2);
}

/** Actual disk reads fail explicitly. The tolerant parser is only for legacy previews. */
export function parseChatsStrict(raw:string):ChatsFile{
  if(!raw.trim())return {version:1,conversations:[]};
  try{const j=JSON.parse(raw);if(!j||j.version!==1||!Array.isArray(j.conversations))throw Error();
    const ids=new Set<string>();const mids=new Set<string>();
    for(const c of j.conversations){if(!c||typeof c.id!=='string'||!c.id||ids.has(c.id)||!Array.isArray(c.messages))throw Error();ids.add(c.id);
      for(const m of c.messages){if(!m||!['user','assistant'].includes(m.role)||typeof m.content!=='string')throw Error();if(m.id!=null){if(typeof m.id!=='string'||!m.id||mids.has(m.id))throw Error();mids.add(m.id);}}
    }const parsed=parseChats(raw);const unique=new Set(parsed.conversations.flatMap(c=>c.messages.map(m=>m.id)));if(unique.size!==parsed.conversations.reduce((n,c)=>n+c.messages.length,0))throw Error();return parsed;
  }catch{throw Error('原始对话读取失败：历史文件格式损坏或不受支持。原文件已保留，请先恢复或检查文件，不能作为空对话覆盖。');}
}

const LS_KEY = (projectId: string, boardId: string) =>
  `lumen.chats.${projectId}.${boardId}`;

function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 加载某白板的对话历史；Tauri 走 chats.json，浏览器回退 localStorage。 */
export async function loadBoardChats(
  projectId: string,
  boardId: string,
  expectedScope?:string,
): Promise<ChatsFile> {
  try {
    if (hasTauri()) {
      const { api } = await import('../api');
      return parseChatsStrict(await api.chatsRead(projectId, boardId,expectedScope));
    }
    if (typeof localStorage !== 'undefined') {
      const raw=localStorage.getItem(LS_KEY(projectId, boardId));
      if(raw!==null&&!raw.trim())throw Error('原始对话文件为空，已保留，请先检查或恢复。');
      return parseChatsStrict(raw ?? '');
    }
  } catch (error) {
    throw new Error(`无法载入原始对话，原文件未改动：${String(error)}`);
  }
  return { version: 1, conversations: [] };
}

export async function loadBoardChatsSnapshot(projectId:string,boardId:string):Promise<{chats:ChatsFile;scope?:string}>{
 if(hasTauri()){try{const {api}=await import('../api');const snapshot=await api.chatsReadSnapshot(projectId,boardId);return {chats:parseChatsStrict(snapshot.content),scope:snapshot.scope};}catch(error){throw Error(`无法载入原始对话，原文件未改动：${String(error)}`);}}
 return {chats:await loadBoardChats(projectId,boardId)};
}

/** 保存某白板的对话历史。写失败仅告警，不影响会话进行。 */
export async function saveBoardChats(
  projectId: string,
  boardId: string,
  chats: ChatsFile,
): Promise<void> {
  const raw = serializeChats(chats);
  try {
    if (hasTauri()) {
      const { api } = await import('../api');
      await api.chatsWrite(projectId, boardId, raw);
      return;
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_KEY(projectId, boardId), raw);
    }
  } catch (e) {
    throw new Error(`保存对话历史失败：${String(e)}`);
  }
}

export function newId(): string {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 从首条用户消息生成一个简短标题。 */
export function deriveTitle(messages: StoredMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  const raw = (firstUser?.content ?? '新对话').replace(/\s+/g, ' ').trim();
  return raw.length > 24 ? raw.slice(0, 24) + '…' : raw || '新对话';
}

/** Native per-conversation merge avoids stale whole-file writes across node windows. */
const browserSaves=new Map<string,Promise<unknown>>();
function mergeConversation(chats:ChatsFile,incoming:Conversation):void{
 const index=chats.conversations.findIndex(c=>c.id===incoming.id);if(index<0){chats.conversations.push(incoming);return;}
 const old=chats.conversations[index];if(old.sourceNodeId!==incoming.sourceNodeId)throw Error('对话来源节点不一致，原始记录未覆盖。');
 const messages=old.messages.slice();for(const message of incoming.messages){const at=messages.findIndex(m=>m.id===message.id);if(at<0)messages.push(message);else if(message.role==='assistant'&&messages[at].role==='assistant'&&message.content.startsWith(messages[at].content))messages[at]=message;}
 chats.conversations[index]={...old,...(incoming.updatedAt>=old.updatedAt?{title:incoming.title,updatedAt:incoming.updatedAt}:{}),messages};
}
export async function saveConversation(projectId:string,boardId:string,conversation:Conversation,expectedScope?:string,generationToken?:string):Promise<void>{
 if(hasTauri()){if(!expectedScope)throw Error('原始对话目录尚未确认，未写入。');const {invoke}=await import('@tauri-apps/api/core');await invoke('chat_conversation_upsert',{projectId,boardId,conversation,expectedScope,generationToken});return;}
 const key=LS_KEY(projectId,boardId),snapshot=structuredClone(conversation);
 const merge=async()=>{const chats=await loadBoardChats(projectId,boardId);mergeConversation(chats,snapshot);parseChatsStrict(serializeChats(chats));await saveBoardChats(projectId,boardId,chats);};
 const next=(browserSaves.get(key)??Promise.resolve()).catch(()=>{}).then(async()=>{if(typeof navigator!=='undefined'&&navigator.locks)await navigator.locks.request(key,merge);else await merge();});browserSaves.set(key,next);
 try{await next;}finally{if(browserSaves.get(key)===next)browserSaves.delete(key);}
}
