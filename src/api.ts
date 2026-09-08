import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

/* ── 与 src-tauri/src/storage.rs 的数据模型一一对应 ── */

export type AppConfig = { storage_root: string | null };

export type ProjectMeta = {
  id: string;
  name: string;
  created_at: string;
};

export type BoardMeta = {
  id: string;
  name: string;
  updated_at: string;
};

export type Viewport = { x: number; y: number; zoom: number };

export type DocRef = {
  path: string; // 相对白板文件夹
  title: string;
  bytes?: number | null;
};

export type BoardNode = {
  id: string;
  title: string;
  summary?: string | null;
  x: number;
  y: number;
  w: number;
  color?: string | null;
  docs: DocRef[];
  created_at: string;
  updated_at: string;
};

export type BoardEdge = {
  id: string;
  from: string;
  to: string;
  directed: boolean;
  label?: string | null;
  created_at: string;
};

export type BoardFile = {
  version: number;
  id: string;
  name: string;
  projectId: string;
  created_at: string;
  updated_at: string;
  viewport: Viewport;
  nodes: BoardNode[];
  edges: BoardEdge[];
};

export type AppInfo = { name: string; version: string; platform: string };

/** 打开系统目录选择框（tauri-plugin-dialog） */
export async function pickStorageDir(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title: '选择白板存储目录' });
  return typeof picked === 'string' ? picked : null;
}

export const api = {
  appInfo: () => invoke<AppInfo>('get_app_info'),

  configGet: () => invoke<AppConfig>('config_get'),
  configSetRoot: (root: string) => invoke<AppConfig>('config_set_storage_root', { root }),

  projectsList: () => invoke<ProjectMeta[]>('projects_list'),
  projectCreate: (name: string) => invoke<ProjectMeta>('project_create', { name }),
  projectDelete: (id: string) => invoke<void>('project_delete', { id }),
  projectRename: (id: string, name: string) =>
    invoke<ProjectMeta>('project_rename', { id, name }),

  boardsList: (projectId: string) => invoke<BoardMeta[]>('boards_list', { projectId }),
  boardCreate: (projectId: string, name: string) =>
    invoke<BoardMeta>('board_create', { projectId, name }),
  boardLoad: (projectId: string, boardId: string) =>
    invoke<BoardFile>('board_load', { projectId, boardId }),
  boardSave: (board: BoardFile) => invoke<void>('board_save', { board }),
  boardDelete: (projectId: string, boardId: string) =>
    invoke<void>('board_delete', { projectId, boardId }),
  boardRename: (projectId: string, boardId: string, name: string) =>
    invoke<BoardMeta>('board_rename', { projectId, boardId, name }),

  /* ── 文档（M4） ── */
  docsList: (projectId: string, boardId: string) =>
    invoke<DocRef[]>('docs_list', { projectId, boardId }),
  docImport: (projectId: string, boardId: string, srcPath: string) =>
    invoke<DocRef>('doc_import', { projectId, boardId, srcPath }),
  docWrite: (projectId: string, boardId: string, title: string, content: string) =>
    invoke<DocRef>('doc_write', { projectId, boardId, title, content }),
  docRead: (projectId: string, boardId: string, path: string) =>
    invoke<string>('doc_read', { projectId, boardId, path }),
  docDelete: (projectId: string, boardId: string, path: string) =>
    invoke<void>('doc_delete', { projectId, boardId, path }),

  /** 用系统默认程序打开文档（如 PDF）——O-4：点击 PDF = 交系统程序打开 */
  docOpenExternal: (projectId: string, boardId: string, path: string) =>
    invoke<void>('open_doc_external', { projectId, boardId, path }),

  /* ── AI 对话历史持久化（M5，存白板 chats.json） ── */
  chatsRead: (projectId: string, boardId: string) =>
    invoke<string>('chats_read', { projectId, boardId }),
  chatsWrite: (projectId: string, boardId: string, content: string) =>
    invoke<void>('chats_write', { projectId, boardId, content }),

  /* ── API Key 安全存储（M5-7，走 OS 凭据库，明文不落盘） ── */
  secretSet: (account: string, secret: string) =>
    invoke<void>('secret_set', { account, secret }),
  secretGet: (account: string) => invoke<string | null>('secret_get', { account }),
  secretDelete: (account: string) => invoke<void>('secret_delete', { account }),
  secretHas: (account: string) => invoke<boolean>('secret_has', { account }),

  /* ── 全局搜索（M6-6，跨白板全文检索） ── */
  searchAll: (query: string) => invoke<SearchHit[]>('search_all', { query }),
};

/** 全局搜索命中项（与 Rust storage::SearchHit 对应） */
export type SearchHit = {
  projectId: string;
  projectName: string;
  boardId: string;
  boardName: string;
  kind: 'node_title' | 'node_summary' | 'doc_title' | 'doc_content';
  nodeId: string | null;
  docPath: string | null;
  title: string;
  snippet: string;
};

/** 打开系统文件选择框，返回选中的 .md 文件绝对路径（可多选）。 */
export async function pickMarkdownFiles(): Promise<string[]> {
  const picked = await open({
    multiple: true,
    title: '选择 Markdown 文档',
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  });
  if (picked == null) return [];
  return Array.isArray(picked) ? picked : [picked];
}


