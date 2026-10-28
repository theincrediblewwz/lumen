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
  _disk_revision?: string;
  _sync_content_policy?: { mode: string; allowOutsideKnowledge: boolean };
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

const boardRevisions = new Map<string, string>();
/** Only adopt a revision returned atomically with that exact board snapshot. */
export function rememberBoardRevision(board:BoardFile):void { if(board._disk_revision)boardRevisions.set(board.id,board._disk_revision); }
const chatRevisions = new Map<string,string>();
let chatQueue:Promise<unknown>=Promise.resolve();
let saveQueue: Promise<unknown> = Promise.resolve();
async function loadBoard(projectId: string, boardId: string): Promise<BoardFile> {
  const board = await invoke<BoardFile>('board_load', { projectId, boardId });
  if (board._disk_revision) boardRevisions.set(boardId, board._disk_revision);
  return board;
}
function saveBoard(board: BoardFile): Promise<void> {
  const save = saveQueue.then(async () => {
    const expectedRevision = boardRevisions.get(board.id) ?? board._disk_revision ?? '';
    const revision = await invoke<string>('board_save', { board, expectedRevision });
    boardRevisions.set(board.id, revision);
  });
  saveQueue = save.catch(() => {});
  return save;
}

export type AppInfo = { name: string; version: string; platform: string; preview_data_dir?:string|null };

/** 打开系统目录选择框（tauri-plugin-dialog） */
export async function pickStorageDir(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title: '选择白板存储目录' });
  return typeof picked === 'string' ? picked : null;
}

export const api = {
  appInfo: () => invoke<AppInfo>('get_app_info'),

  /** macOS：给当前窗口应用原生材质 + 圆角（无边框窗口自绘圆角用）。非 macOS 空操作。 */
  applyWindowCorners: () => invoke<void>('apply_window_corners'),

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
  boardLoad: loadBoard,
  boardSave: saveBoard,
  boardDelete: (projectId: string, boardId: string) =>
    invoke<void>('board_delete', { projectId, boardId }),
  boardRename: (projectId: string, boardId: string, name: string) =>
    invoke<BoardFile>('board_rename', { projectId, boardId, name }).then(board => { rememberBoardRevision(board); return board; }),

  /* ── 文档（M4） ── */
  docsList: (projectId: string, boardId: string) =>
    invoke<DocRef[]>('docs_list', { projectId, boardId }),
  docImport: (projectId: string, boardId: string, srcPath: string) =>
    invoke<DocRef>('doc_import', { projectId, boardId, srcPath }),
  docWrite: (projectId: string, boardId: string, title: string, content: string) =>
    invoke<DocRef>('doc_write', { projectId, boardId, title, content }),
  docRead: (projectId: string, boardId: string, path: string, expectedScope?:string) =>
    invoke<string>('doc_read', { projectId, boardId, path, expectedScope }),
  docDelete: (projectId: string, boardId: string, path: string) =>
    invoke<void>('doc_delete', { projectId, boardId, path }),

  /** 用系统默认程序打开文档（如 PDF）——O-4：点击 PDF = 交系统程序打开 */
  docOpenExternal: (projectId: string, boardId: string, path: string,expectedScope?:string) =>
    invoke<void>('open_doc_external', { projectId, boardId, path,expectedScope }),

  /* ── AI 对话历史持久化（M5，存白板 chats.json） ── */
  chatsReadSnapshot:(projectId:string,boardId:string,expectedScope?:string)=>invoke<{content:string;revision:string;scope:string}>('chats_read',{projectId,boardId,expectedScope}).then(result=>{chatRevisions.set(boardId,result.revision);return result;}),
  chatsRead: (projectId: string, boardId: string,expectedScope?:string) =>
    invoke<{content:string;revision:string}>('chats_read', { projectId, boardId,expectedScope }).then(result=>{chatRevisions.set(boardId,result.revision);return result.content;}),
  chatsWrite: (projectId: string, boardId: string, content: string):Promise<void> => {
    const save=chatQueue.then(async()=>{const revision=await invoke<string>('chats_write',{projectId,boardId,content,expectedRevision:chatRevisions.get(boardId)??''});chatRevisions.set(boardId,revision);});
    chatQueue=save.catch(()=>{});return save;
  },

  /* ── Native credential storage: explicit backend, no plaintext disk writes ── */
  secretSet: (account: string, secret: string, storage: 'system' | 'local' = 'system') =>
    invoke<void>('secret_set', { account, secret, storage }),
  secretGet: (account: string, storage: 'system' | 'local' = 'system') => invoke<string | null>('secret_get', { account, storage }),
  secretDelete: (account: string, storage: 'system' | 'local' = 'system') => invoke<void>('secret_delete', { account, storage }),
  secretHas: (account: string, storage: 'system' | 'local' = 'system') => invoke<boolean>('secret_has', { account, storage }),

  /* ── 全局搜索（M6-6，跨白板全文检索） ── */
  searchAll: (query: string) => invoke<SearchHit[]>('search_all', { query }),

  /* ── 导出（M6-7，写入白板 exports/ 目录，返回绝对路径） ── */
  exportText: (projectId: string, boardId: string, filename: string, content: string) =>
    invoke<string>('export_text', { projectId, boardId, filename, content }),
  exportBinary: (projectId: string, boardId: string, filename: string, b64: string) =>
    invoke<string>('export_binary', { projectId, boardId, filename, b64 }),

  /* ── 快照与恢复（M6-8，白板 .snapshots/，保留最近 20 份） ── */
  snapshotList: (projectId: string, boardId: string) =>
    invoke<SnapshotMeta[]>('snapshot_list', { projectId, boardId }),
  snapshotCreate: (projectId: string, boardId: string, backup = false) =>
    invoke<string | null>('snapshot_create', { projectId, boardId, backup }),
  snapshotRestore: (projectId: string, boardId: string, file: string) =>
    invoke<BoardFile>('snapshot_restore', { projectId, boardId, file }).then(()=>loadBoard(projectId,boardId)),
  snapshotDelete: (projectId: string, boardId: string, file: string) =>
    invoke<void>('snapshot_delete', { projectId, boardId, file }),
};

/** 白板快照元信息（与 Rust storage::SnapshotMeta 对应） */
export type SnapshotMeta = {
  file: string;
  created_at: string;
  nodes: number;
  edges: number;
  bytes: number;
  auto_backup: boolean;
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
    title: '选择节点文档',
    filters: [{ name: 'Markdown、PDF 与图文 ZIP', extensions: ['md', 'markdown','pdf','zip'] }],
  });
  if (picked == null) return [];
  return Array.isArray(picked) ? picked : [picked];
}
