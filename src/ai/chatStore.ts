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
            messages: (c.messages || []).map((m) => ({
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

const LS_KEY = (projectId: string, boardId: string) =>
  `lumen.chats.${projectId}.${boardId}`;

function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 加载某白板的对话历史；Tauri 走 chats.json，浏览器回退 localStorage。 */
export async function loadBoardChats(
  projectId: string,
  boardId: string,
): Promise<ChatsFile> {
  try {
    if (hasTauri()) {
      const { api } = await import('../api');
      return parseChats(await api.chatsRead(projectId, boardId));
    }
    if (typeof localStorage !== 'undefined') {
      return parseChats(localStorage.getItem(LS_KEY(projectId, boardId)) ?? '');
    }
  } catch {
    /* 读失败当作空历史，绝不阻塞对话 */
  }
  return { version: 1, conversations: [] };
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
    console.warn('保存对话历史失败', e);
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
