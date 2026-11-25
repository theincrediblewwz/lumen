import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Minimize2 } from 'lucide-react';
import { api, pickStorageDir, type AppInfo, type BoardEdge, type BoardFile, type BoardMeta, type BoardNode, type ProjectMeta } from './api';
import { ContextMenu, type ContextMenuState } from './components/ContextMenu';
import { TitleBar } from './components/TitleBar';
import { ProjectCanvas } from './components/ProjectCanvas';
import { ProjectCoverPicker } from './components/ProjectCoverPicker';
import { ProjectPath } from './components/ProjectPath';
import { TagEditor, TagFilter } from './components/CatalogTags';
import { ConfirmAction } from './components/ConfirmAction';
import { BoardCanvas } from './components/BoardCanvas';
import { ReaderOverlay } from './components/ReaderOverlay';
import { AiFab } from './components/AiFab';
import { WorkspaceAssistant } from './components/WorkspaceAssistant';
import { ConversationImport } from './components/ConversationImport';
import type { Viewport } from './canvas/CanvasEngine';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { SettingsPanel } from './components/SettingsPanel';
import { GlobalSearch } from './components/GlobalSearch';
import { SnapshotPanel } from './components/SnapshotPanel';
import { ShortcutsHelp } from './components/ShortcutsHelp';
import { matchShortcut, isEditableTarget, shortcut } from './canvas/shortcuts';
import { exportMarkdown, exportHtml, exportSvg } from './canvas/boardExport';
import { loadSettings, saveSettings, applySettings, type Settings } from './settings';
import { registerEditorFlush,registerLibraryRefresh } from './sync/events';
import { getSyncStatus, startForegroundSync } from './sync/service';
import { KnowledgeLibrary } from './components/KnowledgeLibrary';
import type { KnowledgeDraft } from './knowledge/store';
import {exportBoardPackage,importBoardPackage} from './documents/client';
import {exportLibraryPackage,restoreLibraryPackage,applyLibraryPreferences} from './libraryPackages';

import { applyPins, loadFavorites, saveFavorites } from './favorites';
import type { BoardAppearance } from './canvas/presentation';
import { boardCardId, catalogTiles, EMPTY_PROJECT_LAYOUT, parentProject, projectPath, relationEndpoint, type CatalogTile, type ProjectLayoutSnapshot, type ProjectRelation, type RelationBend } from './projectCanvas/layout';
import { EMPTY_COVERS, readCover, type CoverTarget } from './projectCanvas/covers';
import { allTags, assignedTags, colorTag, NO_TAGS, tagKey, type TagDefinition, type TagTarget } from './projectCanvas/tags';

type Phase = 'loading' | 'setup' | 'ready';
type AppMenuState = ContextMenuState & { source?: 'titlebar' | 'create' };
type CoverEdit = { target: CoverTarget; name: string; current: string | null; scope: string; trigger?: HTMLElement | null };

type Editing =
  | null
  | { kind: 'new-project'; parentId: string | null }
  | { kind: 'new-board'; projectId: string }
  | { kind: 'rename-project'; id: string; value: string }
  | { kind: 'rename-board'; id: string; value: string };

/** 将 SVG 字符串栅格化为 PNG，返回 base64（不含 data URL 前缀）。 */
async function svgToPngBase64(svg: string): Promise<string> {
  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('SVG 载入失败'));
      img.src = url;
    });
    const scale = 2; // 2x 更清晰
    const w = img.naturalWidth || img.width || 800;
    const h = img.naturalHeight || img.height || 600;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布上下文');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    return dataUrl.replace(/^data:image\/png;base64,/, '');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [appInfo, setAppInfo] = useState<AppInfo>();
  const platform = appInfo?.platform ?? '';
  const titlebarHeight = appInfo?.mac_titlebar_height;
  const surfaceStyle = titlebarHeight ? { '--titlebar-height': `${titlebarHeight}px` } as CSSProperties : undefined;
  const [root, setRoot] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [layout, setLayout] = useState(EMPTY_PROJECT_LAYOUT);
  const [covers, setCovers] = useState(EMPTY_COVERS);
  const [coverEdit, setCoverEdit] = useState<CoverEdit>();
  const [canvasScope, setCanvasScope] = useState('');
  const [workspaceAiOpen, setWorkspaceAiOpen] = useState(false);
  const [tagFilters, setTagFilters] = useState<Record<string, string[]>>({});
  const [tagEdit, setTagEdit] = useState<{ target: TagTarget; name: string; colorMark?: string }>();
  const [boards, setBoards] = useState<BoardMeta[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectMeta | null>(null);
  const [activeBoard, setActiveBoardState] = useState<BoardFile | null>(null);
  const [boardActionSlot, setBoardActionSlot] = useState<HTMLSpanElement | null>(null);
  const [branchFocusActive, setBranchFocusActive] = useState(false);
  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;
  const routeGeneration = useRef(0);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [knowledgeIndexCollapsed, setKnowledgeIndexCollapsed] = useState(false);
  const knowledgeEditing = useRef(false);
  const knowledgeNavigation = useRef<((accept: () => void) => void) | null>(null);
  const registerKnowledgeNavigation = useCallback((handler: ((accept: () => void) => void) | null) => {
    knowledgeNavigation.current = handler;
  }, []);
  const leaveKnowledge = useCallback((action?: () => void) => {
    const accept = () => { setKnowledgeOpen(false); setError(null); action?.(); };
    if (knowledgeNavigation.current) knowledgeNavigation.current(accept);
    else accept();
  }, []);
  const [knowledgeTarget, setKnowledgeTarget] = useState<{ entryId?: string; revisionId?: string; draft?: KnowledgeDraft }>({});
  useEffect(() => {
    if (knowledgeOpen && !document.querySelector('[role="alertdialog"]')) document.querySelector<HTMLElement>('.knowledge-workspace')?.focus();
  }, [knowledgeOpen, knowledgeTarget]);
  useEffect(() => {
    const open = (event: Event) => { setKnowledgeTarget((event as CustomEvent).detail ?? {}); setKnowledgeOpen(true); };
    window.addEventListener('lumen:open-knowledge', open);
    let unlisten: (() => void) | undefined;
    let active = true;
    if ('__TAURI_INTERNALS__' in window) void import('@tauri-apps/api/event').then(({ listen }) => listen<{ entryId?: string; revisionId?: string; draft?: KnowledgeDraft }>('lumen://open-knowledge', event => { setKnowledgeTarget(event.payload); setKnowledgeOpen(true); })).then(stop => { if (active) unlisten = stop; else stop(); }).catch(error => setError(String(error)));
    return () => { active = false; unlisten?.(); window.removeEventListener('lumen:open-knowledge', open); };
  }, []);
  const [favoriteVersion,setFavoriteVersion]=useState(0);
  const favorites = useMemo(() => applyPins(loadFavorites(root ?? ''), layout.pins), [root, favoriteVersion, layout.pins]);
  const toggleFavorite = (kind: 'projects' | 'boards', id: string) => {
    if (!root) return;
    const owner = kind === 'boards' ? activeProject?.id ?? null : null;
    const pinned = !favorites[kind].includes(id);
    const key = owner ? `${owner}/${id}` : id;
    if (Object.prototype.hasOwnProperty.call(layout.pins ?? {}, key)) {
      void api.projectCanvasPin(kind === 'projects' ? 'project' : 'board', id, owner, pinned, canvasScope)
        .then(setLayout).catch(error => setError(String(error)));
      return;
    }
    try {
      const prior = loadFavorites(root);
      saveFavorites(root, { ...prior, [kind]: pinned ? [...prior[kind], id] : prior[kind].filter(value => value !== id) });
      setFavoriteVersion(version => version + 1);
    } catch (error) { setError(`收藏未能保存：${String(error)}`); }
  };
  const [saveState,setSaveState]=useState<'saved'|'dirty'|'saving'|'error'>('saved');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingBoards = useRef(new Map<string,BoardFile>());
  const pendingSave = useRef<Promise<void>>(Promise.resolve());
  const activeBoardRef = useRef<BoardFile | null>(null);
  const setActiveBoard = useCallback((board: BoardFile | null) => {
    activeBoardRef.current = board;
    setActiveBoardState(board);
  }, []);
  const [boardGeneration,setBoardGeneration] = useState(0);
  const [syncLocked,setSyncLocked] = useState(false);
  const syncLockRef = useRef(false);
  const pointerActiveRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [archiveStatus, setArchiveStatus] = useState<string | null>(null);
  const onKnowledgeEditingChange = useCallback((editing: boolean) => {
    knowledgeEditing.current = editing;
    if (!editing) setError(previous => previous === '当前写作尚未保存，请保存或取消写作后再关闭窗口。' ? null : previous);
  }, []);

  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenPending = useRef(false);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [menu, setMenu] = useState<AppMenuState | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState('');
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const editSubmitting = useRef(false);
  const [deletion, setDeletion] = useState<{ message: string; accept: () => void; confirmLabel?: string } | null>(null);
  const cancelDeletion = useCallback(() => setDeletion(null), []);
  // AI 引用跳转的目标节点（M5-6）：{nodeId, nonce} —— nonce 保证同一节点重复点也触发
  const [focusNode, setFocusNode] = useState<{ id: string; nonce: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [importTarget,setImportTarget]=useState<{projectId:string;boardId?:string;boardName?:string}>();
  const [helpOpen, setHelpOpen] = useState(false);
  const editRef = useRef<HTMLInputElement>(null);
  const mac = /darwin|mac/i.test(platform);
  const projectTrail = useMemo(() => projectPath(projects, layout, activeProject?.id ?? null), [projects, layout, activeProject?.id]);
  const tiles = useMemo(() => catalogTiles(projects, boards, layout, activeProject?.id ?? null, favorites, covers), [projects, boards, layout, activeProject?.id, favorites, covers]);
  const tags = useMemo(() => allTags(layout.tags), [layout.tags]);
  const filterKey = JSON.stringify([canvasScope || root, activeBoard ? 'board' : 'project', activeBoard?.id ?? activeProject?.id ?? null]);
  const filterIds = tagFilters[filterKey] ?? NO_TAGS;
  const tagFilter = useMemo(() => new Set(filterIds), [filterIds]);
  const visibleTiles = useMemo(() => tagFilter.size ? tiles.filter(tile => tile.tagIds.some(id => tagFilter.has(id))) : tiles, [tiles, tagFilter]);
  const previewTiles = useCallback((projectId: string, childBoards: BoardMeta[]) => {
    const children = catalogTiles(projects, childBoards, layout, projectId, favorites, covers);
    return tagFilter.size ? children.filter(tile => tile.tagIds.some(id => tagFilter.has(id))) : children;
  }, [projects, layout, favorites, covers, tagFilter]);

  const readCatalog = useCallback(async () => {
    const [rows, placement] = await Promise.all([
      api.projectsList(),
      api.projectCanvasRead().catch((error): ProjectLayoutSnapshot => {
        setError(`项目画布未能读取：${String(error)}`);
        return { layout: EMPTY_PROJECT_LAYOUT, scope: '' };
      }),
    ]);
    if (placement.coverError) setError(`封面记录未能读取：${placement.coverError}`);
    return { rows, ...placement, covers: placement.covers ?? EMPTY_COVERS };
  }, []);

  const refreshProjects = useCallback(async () => {
    const current = await readCatalog();
    setProjects(current.rows);
    setLayout(current.layout);
    setCovers(current.covers);
    setCanvasScope(current.scope);
  }, [readCatalog]);

  /* 应用外观设置（主题 / 玻璃 / 动画）到 <html>；platform 变化后重跑
     （原生材质仅 macOS 启用，需知道平台才能正确决定 native/实色）。 */
  useEffect(() => {
    applySettings(settings, platform);
    saveSettings(settings);
  }, [settings, platform]);

  const patchSettings = useCallback(
    (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  );

  const flushBoards = useCallback(async () => {
    if(saveTimer.current)clearTimeout(saveTimer.current);
    const run=pendingSave.current.catch(()=>{}).then(async()=>{
      while(pendingBoards.current.size){
        const [id,board]=pendingBoards.current.entries().next().value!;
        setSaveState('saving');await api.boardSave(board);
        if(pendingBoards.current.get(id)===board)pendingBoards.current.delete(id);
      }
      setSaveState('saved');
    });
    pendingSave.current=run;
    try {await run;} catch(error){setSaveState('error');throw error;}
  },[]);
  useEffect(()=>{const flush=()=>{if(pendingBoards.current.size&&!syncLockRef.current)void flushBoards().catch(e=>setError(String(e)));};window.addEventListener('blur',flush);return()=>window.removeEventListener('blur',flush);},[flushBoards]);
  useEffect(()=>registerEditorFlush(async()=>{
    if(syncLockRef.current)throw new Error('主窗口正在保存或同步，请稍后重试');
    if(pointerActiveRef.current||(isEditableTarget(document.activeElement)&&!document.activeElement?.closest('.ai-root,.conversation-import')))throw new Error('正在编辑内容，请先完成本次操作后重试');
    window.dispatchEvent(new CustomEvent('lumen:sync-edit-lock',{detail:true}));
    try{await flushBoards();}catch(error){window.dispatchEvent(new CustomEvent('lumen:sync-edit-lock',{detail:false}));throw error;}
  }),[flushBoards]);
  useEffect(()=>{
    const start=()=>{pointerActiveRef.current=true;};const end=()=>{pointerActiveRef.current=false;};
    window.addEventListener('pointerdown',start);window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);window.addEventListener('blur',end);
    return()=>{window.removeEventListener('pointerdown',start);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);window.removeEventListener('blur',end);};
  },[]);
  useEffect(()=>{
    if(!('__TAURI_INTERNALS__' in window))return;
    let closing=false;let disposed=false;let stop:(()=>void)|undefined;
    const nativeWindow=getCurrentWindow();
    void nativeWindow.onCloseRequested(async event=>{
      const pending:Promise<void>[]=[];
      if(!window.dispatchEvent(new CustomEvent('lumen:before-window-close',{cancelable:true,detail:{pending}}))){event.preventDefault();void Promise.allSettled(pending);return;}
      if(knowledgeEditing.current){event.preventDefault();setError('当前写作尚未保存，请保存或取消写作后再关闭窗口。');return;}
      if(closing){event.preventDefault();return;}
      closing=true;
      // Tauri awaits this handler then destroys the window unless prevented.
      try{(document.activeElement as HTMLElement|null)?.blur();await Promise.resolve();await Promise.all(pending);await flushBoards();}
      catch(error){event.preventDefault();closing=false;setError(`未能保存当前编辑，窗口保留：${String(error)}`);}
    }).then(unlisten=>{if(disposed)unlisten();else stop=unlisten;});
    return()=>{disposed=true;stop?.();};
  },[flushBoards]);
  useEffect(()=>{if(phase==='ready')return startForegroundSync();},[phase,root]);
  useEffect(()=>{
    const lock=(value:boolean)=>{syncLockRef.current=value;setSyncLocked(value);};
    const onLock=(event:Event)=>lock(!!(event as CustomEvent<boolean>).detail);
    let generation=0;
    const refresh=async()=>{
      const request=++generation;
      const route = routeGeneration.current;
      try {
        await flushBoards();
        const catalog = await readCatalog();
        if (request !== generation || route !== routeGeneration.current) return;
        const current = activeBoardRef.current;
        const folder = catalog.rows.find(p => p.id === activeProjectRef.current?.id) ?? null;
        const nextBoards = folder ? await api.boardsList(folder.id) : [];
        const board = current && nextBoards.some(b => b.id === current.id)
          ? await api.boardLoad(current.projectId, current.id) : null;
        if (request !== generation || route !== routeGeneration.current) return;
        setProjects(catalog.rows); setLayout(catalog.layout); setCovers(catalog.covers); setCanvasScope(catalog.scope);
        activeProjectRef.current = folder; setActiveProject(folder); setBoards(nextBoards);
        setActiveBoard(board); setBoardGeneration(n => n + 1);
      }catch(error){setError(String(error));throw error;}
    };
    const unregisterRefresh=registerLibraryRefresh(refresh);
    const onChanged=()=>{void refresh().catch(()=>{});};
    window.addEventListener('lumen:sync-edit-lock',onLock);
    window.addEventListener('lumen:library-changed',onChanged);
    let disposed=false;const stops:(()=>void)[]=[];
    if('__TAURI_INTERNALS__' in window)void import('@tauri-apps/api/event').then(async({listen,emit})=>{
      const add=async(p:Promise<()=>void>)=>{const stop=await p;if(disposed)stop();else stops.push(stop);};
      await add(listen<{requestId:string}>('lumen://flush-editor',async event=>{
        let error:string|undefined;
        if(syncLockRef.current||pointerActiveRef.current||(isEditableTarget(document.activeElement)&&!document.activeElement?.closest('.ai-root,.conversation-import')))error='主窗口正在操作或同步，请稍后保存';
        else {lock(true);try{await flushBoards();}catch(e){error=String(e);lock(false);}}
        await emit('lumen://flush-complete',{requestId:event.payload.requestId,error});
      }));
      await add(listen('lumen://release-editor',()=>lock(false)));
      await add(listen<{fromMain?:boolean;requestId?:string}>('lumen://library-changed',async event=>{
        if(event.payload?.fromMain)return;
        let error:string|undefined;try{await refresh();}catch(e){error=String(e);}
        if(event.payload?.requestId)await emit('lumen://refresh-complete',{requestId:event.payload.requestId,error});
      }));
    });
    return()=>{disposed=true;unregisterRefresh();stops.forEach(stop=>stop());window.removeEventListener('lumen:sync-edit-lock',onLock);window.removeEventListener('lumen:library-changed',onChanged);};
  },[flushBoards, readCatalog]);

  /* 启动：读平台信息 + 配置 */
  useEffect(() => {
    api.appInfo().then(setAppInfo).catch(() => {});
    api
      .configGet()
      .then(async (cfg) => {
        if (!cfg.storage_root) {
          setPhase('setup');
          return;
        }
        setRoot(cfg.storage_root);
        await refreshProjects();
        setPhase('ready');
      })
      .catch((e: unknown) => {
        setError(String(e));
        setPhase('setup');
      });
  }, [refreshProjects]);

  /* 屏蔽 WebView 自带的原生右键菜单（刷新/打印/另存为…）。
     应用内的右键交互由各元素的 onContextMenu 显式弹出，不受影响。 */
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    window.addEventListener('contextmenu', block);
    return () => window.removeEventListener('contextmenu', block);
  }, []);

  /* ── 全屏模式 ── */
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    const nativeWindow = getCurrentWindow();
    let disposed = false;
    let stop: (() => void) | undefined;
    const refresh = () => {
      if (fullscreenPending.current) return;
      void nativeWindow.isFullscreen().then(active => {
        if (!disposed && !fullscreenPending.current && typeof active === 'boolean') setFullscreen(active);
      }).catch(() => {});
    };
    refresh();
    void nativeWindow.onResized(refresh).then(unlisten => {
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch(() => {});
    return () => { disposed = true; stop?.(); };
  }, []);
  const applyFullscreen = useCallback(async (on: boolean) => {
    if (fullscreenPending.current) return;
    fullscreenPending.current = true;
    try {
      await getCurrentWindow().setFullscreen(on);
      setFullscreen(on);
    } catch (err) {
      setError(`无法${on ? '进入' : '退出'}全屏。${String(err)}`);
    } finally {
      fullscreenPending.current = false;
    }
  }, []);
  const enterFullscreen = () => { void applyFullscreen(true); };

  /* 全局快捷键（M6-9）：全屏 / 搜索 / 帮助；Esc 退出全屏。画布级快捷键在 BoardCanvas 内处理 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s') {
        e.preventDefault();void flushBoards().catch(err=>setError(String(err)));
      } else if (matchShortcut(e, shortcut('fullscreen')!, { mac })) {
        e.preventDefault();
        if (!e.repeat) void applyFullscreen(!fullscreen);
      } else if (matchShortcut(e, shortcut('search')!, { mac })) {
        // 全局搜索（M6-6）——在输入框里也允许（方便随时唤出）
        e.preventDefault();
        setSearchOpen((v) => !v);
      } else if (!isEditableTarget(e.target) && matchShortcut(e, shortcut('help')!, { mac })) {
        // 快捷键帮助（Shift+/ 即 ?）；打字时不触发
        e.preventDefault();
        setHelpOpen((v) => !v);
      } else if (e.key === 'Escape' && fullscreen && !branchFocusActive) {
        void applyFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen, applyFullscreen, mac,flushBoards,branchFocusActive]);

  useEffect(() => {
    if (editing) {
      setDraft(
        editing.kind === 'rename-project' || editing.kind === 'rename-board' ? editing.value : '',
      );
      // 等 DOM 渲染出输入框再聚焦
      requestAnimationFrame(() => editRef.current?.focus());
    }
  }, [editing]);

  const refreshBoards = useCallback(async (projectId: string) => {
    const rows = await api.boardsList(projectId);
    if (activeProjectRef.current?.id === projectId) setBoards(rows);
  }, []);

  // ── AI 引用跳转（M5-6）：切到目标白板并高亮节点 ──
  const jumpTo = useCallback(
    (projectId: string, boardId: string, nodeId: string | null) =>
      leaveKnowledge(() => void withBusy(async () => {
        routeGeneration.current++;
        await flushBoards();
        const [catalog, nextBoards, nextBoard] = await Promise.all([
          readCatalog(), api.boardsList(projectId), api.boardLoad(projectId, boardId),
        ]);
        const folder = catalog.rows.find(row => row.id === projectId);
        if (!folder || !nextBoards.some(row => row.id === boardId)) throw new Error('这块白板已不在资料库中。');
        setProjects(catalog.rows); setLayout(catalog.layout); setCovers(catalog.covers); setCanvasScope(catalog.scope);
        activeProjectRef.current = folder; setActiveProject(folder); setBoards(nextBoards);
        setActiveBoard(nextBoard);
        if (nodeId) setTagFilters(old => ({ ...old, [JSON.stringify([catalog.scope, 'board', boardId])]: [] }));
        setFocusNode(nodeId ? { id: nodeId, nonce: Date.now() } : null);
        void api.snapshotCreate(projectId, boardId, false).catch(() => {});
      })),
    [leaveKnowledge, flushBoards, readCatalog],
  );

  useEffect(() => {
    const onCustom = (e: Event) => {
      const d = (e as CustomEvent<{ projectId: string; boardId: string; nodeId: string }>).detail;
      if (d) jumpTo(d.projectId, d.boardId, d.nodeId);
    };
    window.addEventListener('lumen://jump-node', onCustom as EventListener);

    let unlisten: (() => void) | undefined;
    (async () => {
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        try {
          const { listen } = await import('@tauri-apps/api/event');
          unlisten = await listen<{ projectId: string; boardId: string; nodeId: string }>(
            'lumen://jump-node',
            (ev) => {
              const d = ev.payload;
              if (d) jumpTo(d.projectId, d.boardId, d.nodeId);
            },
          );
        } catch {
          /* 非 Tauri 忽略 */
        }
      }
    })();

    return () => {
      window.removeEventListener('lumen://jump-node', onCustom as EventListener);
      unlisten?.();
    };
  }, [jumpTo]);

  /* ── 打开白板：加载 board.json 到画布 ── */
  const openBoard = (projectId: string, boardId: string) => jumpTo(projectId, boardId, null);

  /* The latest viewport shares the same pending snapshot as graph edits. */
  const queueBoardSave = useCallback((board: BoardFile) => {
    activeBoardRef.current = board;
    pendingBoards.current.set(board.id, board);
    setSaveState('dirty');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flushBoards().catch(error => setError(String(error))); }, 600);
  }, [flushBoards]);

  const onCanvasChange = useCallback((nodes: BoardNode[], edges: BoardEdge[], viewport: Viewport, appearance?: BoardAppearance) => {
    const previous = activeBoardRef.current;
    if (!previous || syncLockRef.current) return;
    const next = { ...previous, nodes, edges, viewport, ...(appearance ? { appearance } : {}) };
    queueBoardSave(next);
    setActiveBoardState(next);
  }, [queueBoardSave]);

  const onViewportChange = useCallback((viewport: Viewport) => {
    const board = activeBoardRef.current;
    if (!board || syncLockRef.current) return;
    const old = board.viewport;
    if (viewport.x === old.x && viewport.y === old.y && viewport.zoom === old.zoom) return;
    queueBoardSave({ ...board, viewport });
  }, [queueBoardSave]);

  const withBusy = async (fn: () => Promise<void>, reportError: (message: string) => void = setError) => {
    if(document.querySelector('.board-canvas-live[aria-busy="true"]')){reportError('请先完成正在进行的画布操作。');return;}
    if(document.querySelector('.document-editor-modal')){reportError('请先保存并关闭Markdown编辑器，再切换白板或项目。');return;}
    if (busyRef.current) return;
    if (syncLockRef.current) { reportError('正在保存或同步，请稍后再试。'); return; }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setArchiveStatus(null);
    try {
      await fn();
    } catch (e: unknown) {
      setArchiveStatus(null);
      reportError(String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const withBoardEditLock = async (fn: () => Promise<void>) => {
    if (syncLockRef.current) throw new Error('正在保存或同步，请稍后重试');
    window.dispatchEvent(new CustomEvent('lumen:sync-edit-lock', { detail: true }));
    try { await flushBoards(); await fn(); }
    finally { window.dispatchEvent(new CustomEvent('lumen:sync-edit-lock', { detail: false })); }
  };

  /* ── 存储目录 ── */
  const ensureLibraryCanSwitch = async () => {
    const closing = new Event('lumen:before-window-close', { cancelable: true });
    if (!window.dispatchEvent(closing)) throw Error('请先完成或保存正在进行的对话，再切换资料库。恢复副本及原库仍保留。');
    if (document.querySelector('.reader-overlay')) throw Error('请先关闭当前阅读器，再切换资料库。');
    if ('__TAURI_INTERNALS__' in window) {
      const { getAllWebviewWindows } = await import('@tauri-apps/api/webviewWindow');
      const windows = await getAllWebviewWindows();
      if (windows.some(win => /^(reader|ai)-/.test(win.label))) throw Error('请先关闭独立阅读和 AI 窗口，再切换资料库；运行中的对话继续保留。');
    }
  };
  const chooseDir = () =>
    withBusy(async () => {
      if (knowledgeEditing.current) throw new Error('请先保存或取消知识写作，再切换资料目录。');
      if (getSyncStatus().busy) throw new Error('请等待当前同步完成，再切换资料目录。');
      await ensureLibraryCanSwitch();
      const picked = await pickStorageDir();
      if (!picked) return;
      if (knowledgeEditing.current) throw new Error('请先保存或取消知识写作，再切换资料目录。');
      if (getSyncStatus().busy) throw new Error('请等待当前同步完成，再切换资料目录。');
      await ensureLibraryCanSwitch();
      await flushBoards();
      const cfg = await api.configSetRoot(picked);
      routeGeneration.current++;
      setRoot(cfg.storage_root);
      activeProjectRef.current = null;
      setActiveProject(null);
      setActiveBoard(null);
      setKnowledgeOpen(false);
      setKnowledgeTarget({});
      setBoards([]);
      await refreshProjects();
      setPhase('ready');
    });

  const commitEdit = async () => {
    if (editSubmitting.current || busyRef.current) return;
    const cur = editingRef.current;
    if (!cur) return;
    const name = draft.trim();
    if (!name) { editingRef.current = null; setEditing(null); return; }
    editSubmitting.current = true;
    await withBusy(async () => {
      const finish = () => { editingRef.current = null; setEditing(null); };
      if (cur.kind === 'new-project') {
        await withBoardEditLock(async () => {
          if (cur.parentId && !canvasScope) throw new Error('请先恢复项目画布，再新建子项目。');
          await api.projectCreate(name, cur.parentId, canvasScope || undefined);
          finish();
          await refreshProjects();
        });
      } else if (cur.kind === 'new-board') {
        await withBoardEditLock(async () => {
          const created = await api.boardCreate(cur.projectId, name);
          finish();
          setBoards(rows => [...rows, created]);
        });
      } else if (cur.kind === 'rename-project') {
        const renamed = await api.projectRename(cur.id, name);
        finish(); setProjects(rows => rows.map(row => row.id === cur.id ? renamed : row));
        setActiveProject(row => row?.id === cur.id ? renamed : row);
      } else if (cur.kind === 'rename-board') {
        if (!activeProject) throw new Error('请先选择项目');
        await withBoardEditLock(async () => {
          const renamed = await api.boardRename(activeProject.id, cur.id, name);
          finish(); setBoards(rows => rows.map(row => row.id === cur.id ? renamed : row));
          if (activeBoardRef.current?.id === cur.id) {
            setActiveBoard(renamed);
          }
        });
      }
    });
    editSubmitting.current = false;
    if (editingRef.current === cur) editRef.current?.focus();
  };

  const navigateProject = (id: string | null) =>
    leaveKnowledge(() => void withBusy(async () => {
      routeGeneration.current++;
      await flushBoards();
      const folder = id ? projects.find(project => project.id === id) : null;
      if (id && !folder) throw new Error('此项目已不在资料库中。');
      const nextBoards = folder ? await api.boardsList(folder.id) : [];
      activeProjectRef.current = folder ?? null;
      setActiveProject(folder ?? null);
      setBoards(nextBoards);
      setActiveBoard(null);
      setFocusNode(null);
    }));

  const moveProject = (id: string, parentId: string | null) => withBusy(async () => {
    if (!canvasScope) throw new Error('请先恢复项目画布，再移动项目。');
    const next = await api.projectCanvasMove(id, parentProject(layout, id), parentId, canvasScope);
    setLayout(next);
  });

  const placeTile = (tile: CatalogTile, position: { x: number; y: number }, target?: string) => {
    if (tile.kind === 'project' && target) return moveProject(tile.row.id, target);
    return withBusy(async () => {
      if (!canvasScope) throw new Error('请先恢复项目画布，再摆放卡片。');
      setLayout(await api.projectCanvasPlace(tile.kind, tile.row.id, activeProject?.id ?? null, position, canvasScope));
    });
  };

  const relateCards = (relation: ProjectRelation, present: boolean) => void withBusy(async () => {
    if (!canvasScope) throw new Error('请先恢复项目画布，再编辑连线。');
    setLayout(await api.projectCanvasRelate(activeProject?.id ?? null, relation, present, canvasScope));
  });

  const bendRelation = (relation: ProjectRelation, bend: RelationBend | null) => withBusy(async () => {
    if (!canvasScope) throw new Error('请先恢复项目画布，再编辑连线。');
    setLayout(await api.projectCanvasBend(activeProject?.id ?? null, relation, bend, canvasScope));
  });

  const saveCatalog = async (apply: () => Promise<void>) => {
    let saved = false;
    let error = '有一项保存尚未完成，请稍后再试。';
    await withBusy(async () => {
      if (!canvasScope) throw new Error('请先恢复项目画布，再保存此更改。');
      await apply();
      saved = true;
    }, message => { error = message; });
    if (!saved) throw new Error(error.replace(/^Error:\s*/, ''));
  };

  const saveTagDraft = (target: TagTarget, assigned: string[], newTags: Record<string, TagDefinition>) => saveCatalog(async () => {
    if (target.kind === 'node') await flushBoards();
    setLayout(await api.projectCanvasTags(target, assigned, newTags, canvasScope));
  });

  const saveCover = (edit: CoverEdit, coverId: string | null) => saveCatalog(async () => {
    if (edit.scope !== canvasScope) throw Error('资料库已切换，请重新选择封面');
    try {
      const next = await api.projectCanvasCover(edit.target, coverId, edit.current, edit.scope);
      routeGeneration.current++;
      setCovers(next);
    } catch (error) {
      const latest = await api.projectCanvasRead().catch(() => undefined);
      if (latest?.scope === edit.scope && latest.covers) setCovers(latest.covers);
      throw error;
    }
  });

  const removeProject = (p: ProjectMeta) => setDeletion({
    message: `删除项目「${p.name}」？其中的白板与挂载资料都会被移除。知识库内容保留。`,
    accept: () => void withBusy(() => withBoardEditLock(async () => {
      await api.projectDelete(p.id);
      if (activeProject?.id === p.id) {
        activeProjectRef.current = null;
        setActiveProject(null);
        setActiveBoard(null);
        setBoards([]);
      }
      await refreshProjects();
    })),
  });

  const removeBoard = (b: BoardMeta) => {
    if (!activeProject) return;
    const projectId = activeProject.id;
    setDeletion({ message: `删除白板「${b.name}」？其中的挂载资料会一并移除。知识库内容保留。`, accept: () => void withBusy(() => withBoardEditLock(async () => {
      await api.boardDelete(projectId, b.id);
      if (activeBoardRef.current?.id === b.id) setActiveBoard(null);
      await refreshBoards(projectId);
    })) });
  };

  /* ── 右键菜单与按钮菜单 ── */
  const openAt = (
    e: React.MouseEvent,
    items: ContextMenuState['items'],
    { atPointer, source }: { atPointer?: boolean; source?: AppMenuState['source'] } = {},
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const bounds = e.currentTarget.getBoundingClientRect();
    const trigger = e.type === 'click' && !atPointer ? e.currentTarget : undefined;
    const atControl = trigger || (!e.clientX && !e.clientY);
    const next: AppMenuState = {
      x: atControl ? bounds.left : e.clientX,
      y: atControl ? bounds.bottom + 4 : e.clientY,
      items,
      trigger,
      source,
    };
    setMenu(current => trigger && current?.trigger === trigger ? null : next);
  };

  /* ── 导出（M6-7）：写入白板 exports/ 目录，完成后提示路径 ── */
  const cssVar = (name: string, fallback: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

  const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'board';

  const doExport = (kind: 'md' | 'html' | 'svg' | 'png') =>
    withBusy(async () => {
      const b = activeBoard;
      if (!b || !activeProject) return;
      const base = safeName(b.name);
      try {
        let saved = '';
        if (kind === 'md') {
          saved = await api.exportText(activeProject.id, b.id, `${base}.md`, exportMarkdown(b));
        } else if (kind === 'html') {
          saved = await api.exportText(activeProject.id, b.id, `${base}.html`, exportHtml(b));
        } else {
          // SVG/PNG 用当前主题色
          const themed = {
            bg: cssVar('--bg-canvas', '#ffffff'),
            nodeBg: cssVar('--bg-node', '#ffffff'),
            nodeBorder: cssVar('--border-color', '#dcece4'),
            text: cssVar('--text-primary', '#1c1e21'),
            edge: cssVar('--edge-color', '#b4bfba'),
            accent: cssVar('--accent', '#2e5a4e'),
          };
          const svg = exportSvg(b, themed);
          if (kind === 'svg') {
            saved = await api.exportText(activeProject.id, b.id, `${base}.svg`, svg);
          } else {
            const b64 = await svgToPngBase64(svg);
            saved = await api.exportBinary(activeProject.id, b.id, `${base}.png`, b64);
          }
        }
        setError(`已导出到：${saved}`);
        window.setTimeout(() => setError(null), 4000);
      } catch (err) {
        setError(`导出失败：${String(err)}`);
      }
    });

  const exportLibrary = (project?: ProjectMeta) => void withBusy(async () => {
    if (knowledgeEditing.current) throw Error('请先保存或取消知识草稿，再导出已保存内容。');
    const result = await exportLibraryPackage(project, setArchiveStatus);
    if (result) setArchiveStatus(`已导出 ${result.projects} 个项目、${result.boards} 块白板、${result.files} 个文件到：${result.path}。含知识、原件和历史，不含连接密钥。`);
  });
  const restoreLibrary = () => void withBusy(async () => {
    if (knowledgeEditing.current) throw Error('请先保存或取消知识草稿，再恢复资料。');
    if (getSyncStatus().busy) throw Error('请等待当前同步完成后恢复资料。');
    const restored = await restoreLibraryPackage();
    if (!restored) return;
    setArchiveStatus(`已恢复到新目录：${restored.root}。原库保留。`);
    setDeletion({ message: `已校验并恢复 ${restored.files} 个文件到新目录：${restored.root}。现在打开它？原资料库和连接密钥保留，同步连接不会随包启用。`, confirmLabel: '打开恢复的资料库', accept: () => void withBusy(async () => {
      if (knowledgeEditing.current || getSyncStatus().busy) throw Error('请先完成写作或同步，再打开恢复的资料库。');
      await ensureLibraryCanSwitch();
      await flushBoards();
      const cfg = await api.configSetRoot(restored.root);
      const warnings = applyLibraryPreferences(restored.preferences);
      const nextSettings = loadSettings(); setSettings(nextSettings); applySettings(nextSettings, platform);
      routeGeneration.current++;
      setRoot(cfg.storage_root); activeProjectRef.current = null; setActiveProject(null); setActiveBoard(null);
      setKnowledgeOpen(false); setKnowledgeTarget({}); setBoards([]); await refreshProjects(); setPhase('ready');
      setArchiveStatus(warnings.length ? `已打开恢复的资料库。${warnings.join('、')}未能写入本机偏好，备份中的记录仍保留。` : '已打开恢复的资料库，原资料目录保留。');
    }) });
  });

  const createItems = (): Extract<ContextMenuState['items'][number], { type: 'item' }>[] => {
    const project = activeProject;
    return [
      { type: 'item', label: '新建项目', onClick: () => setEditing({ kind: 'new-project', parentId: project?.id ?? null }) },
      ...(project ? [
        { type: 'item' as const, label: '新建白板', onClick: () => setEditing({ kind: 'new-board', projectId: project.id }) },
        { type: 'item' as const, label: '从对话新建白板…', onClick: () => leaveKnowledge(() => setImportTarget({ projectId: project.id })) },
      ] : []),
    ];
  };

  const appMenu = (e: React.MouseEvent) =>
    openAt(e, [
      { type: 'info', text: '脉络 Lumen' },
      { type: 'separator' },
      { type: 'item', label: '全局搜索  Ctrl/Cmd+K', onClick: () => setSearchOpen(true) },
      ...(phase === 'ready' ? [
        { type: 'item' as const, label: 'AI 工作区…', onClick: () => leaveKnowledge(() => setWorkspaceAiOpen(true)) },
        { type: 'item' as const, label: '知识库', onClick: () => {
          if (knowledgeOpen) leaveKnowledge();
          else { setKnowledgeTarget({}); setKnowledgeOpen(true); }
        } },
      ] : []),
      { type: 'group', label: '导入', items: [
        {type:'item',label:'项目/全库资料包（恢复到新目录）…',onClick:restoreLibrary},
        {type:'item',label:'白板资料包…',disabled:!activeProject,onClick:()=>activeProject&&leaveKnowledge(()=>void withBusy(async()=>{const board=await importBoardPackage(activeProject.id);if(board){await refreshBoards(activeProject.id);setActiveBoard(board);setBoardGeneration(n=>n+1);}}))},
        {type:'item',label:activeBoard?'对话 → 当前白板…':'对话 → 新白板…',disabled:!activeProject,onClick:()=>activeProject&&leaveKnowledge(()=>setImportTarget({projectId:activeProject.id,...(activeBoard?{boardId:activeBoard.id,boardName:activeBoard.name}:{})}))},
      ] },
      { type: 'group', label: '导出', items: [
              {type:'item',label:'备份全部内容…',onClick:()=>exportLibrary()},
              {type:'item',label:'导出当前项目…',disabled:!activeProject,onClick:()=>activeProject&&exportLibrary(activeProject)},
              ...(activeBoard ? [
              {type:'item',label:'完整白板资料包（含原件）',onClick:()=>void withBusy(async()=>{const saved=await exportBoardPackage(activeBoard.projectId,activeBoard.id,activeBoard.name);if(saved)setError(`已导出到：${saved}`);})},
              { type: 'item', label: 'Markdown · 保留层级', onClick: () => doExport('md') },
              { type: 'item', label: 'HTML · 离线阅读', onClick: () => doExport('html') },
              { type: 'item', label: 'SVG · 矢量图', onClick: () => doExport('svg') },
              { type: 'item', label: 'PNG · 图片', onClick: () => doExport('png') },
              ] as Extract<ContextMenuState['items'][number], {type:'item'}>[] : []),
            ] },
      ...(activeBoard ? [{ type: 'item', label: '快照与恢复…', onClick: () => setSnapshotOpen(true) }] as ContextMenuState['items'] : []),
      { type: 'separator' },
      { type: 'item', label: '快捷键帮助  ?', onClick: () => setHelpOpen(true) },
      { type: 'item', label: '设置…', onClick: () => setSettingsOpen(true) },
    ], { source: 'titlebar' });

  const coverMenuItem = (event: React.MouseEvent, target: CoverTarget, name: string) => {
    const trigger = event.currentTarget.closest('.project-tile')?.querySelector<HTMLElement>('.project-tile-open');
    return {
      type: 'item' as const, label: '更换封面…', disabled: !canvasScope,
      onClick: () => setCoverEdit({ target, name, current: readCover(covers, target), scope: canvasScope, trigger }),
    };
  };

  const linkMenu = (from: string): ContextMenuState['items'] => {
    const linked = new Set(layout.relations?.filter(edge => edge.from === from).map(edge => edge.to));
    const groups = activeProject ? ['project', 'board'] as const : ['project'] as const;
    return groups.map(kind => {
      const items = tiles.filter(tile => tile.kind === kind).flatMap(tile => {
        const to = relationEndpoint(tile);
        return to === from || linked.has(to) ? [] : [{ type: 'item' as const, label: tile.row.name, onClick: () => relateCards({ from, to }, true) }];
      });
      return { type: 'group', label: kind === 'project' ? '连到项目…' : '连到白板…', disabled: !items.length || !canvasScope, items };
    });
  };

  const projectItemMenu = (e: React.MouseEvent, p: ProjectMeta) => {
    const sourceParent = parentProject(layout, p.id);
    const destinations = projects.flatMap(project => {
      if (project.id === sourceParent) return [];
      const path = projectPath(projects, layout, project.id);
      if (path.some(row => row.id === p.id)) return [];
      return [{
        type: 'item' as const, label: path.map(row => row.name).join(' / '),
        onClick: () => void moveProject(p.id, project.id),
      }];
    });
    if (sourceParent) destinations.unshift({ type: 'item', label: '项目首页', onClick: () => void moveProject(p.id, null) });
    const hasChildren = projects.some(row => parentProject(layout, row.id) === p.id);
    openAt(e, [
      { type: 'item', label: '打开', onClick: () => navigateProject(p.id) },
      coverMenuItem(e, { kind: 'project', id: p.id }, p.name),
      {type:'item',label:favorites.projects.includes(p.id)?'取消收藏置顶':'收藏并置顶',onClick:()=>toggleFavorite('projects',p.id)},
      { type: 'item', label: '编辑标签…', onClick: () => setTagEdit({ target: { kind: 'project', id: p.id }, name: p.name }) },
      ...linkMenu(p.id),
      { type: 'group', label: '移到项目…', disabled: !destinations.length || !canvasScope, items: destinations },
      { type: 'item', label: '导出完整项目资料包…', onClick: () => exportLibrary(p) },
      {
        type: 'item',
        label: '重命名',
        onClick: () => setEditing({ kind: 'rename-project', id: p.id, value: p.name }),
      },
      { type: 'separator' },
      { type: 'item', label: hasChildren ? '先移出子项目再删除' : '删除项目', danger: true, disabled: hasChildren, onClick: () => removeProject(p) },
    ]);
  };

  const boardItemMenu = (e: React.MouseEvent, b: BoardMeta) =>
    openAt(e, [
      { type: 'item', label: '打开', onClick: () => activeProject && openBoard(activeProject.id, b.id) },
      ...(activeProject ? [coverMenuItem(e, { kind: 'board', projectId: activeProject.id, id: b.id }, b.name)] : []),
      {type:'item',label:favorites.boards.includes(b.id)?'取消收藏置顶':'收藏并置顶',onClick:()=>toggleFavorite('boards',b.id)},
      { type: 'item', label: '编辑标签…', onClick: () => {
        if (activeProject) setTagEdit({ target: { kind: 'board', id: b.id, projectId: activeProject.id }, name: b.name });
      } },
      ...(activeProject ? linkMenu(boardCardId(activeProject.id, b.id)) : []),
      { type:'item',label:'导入对话生成树…',onClick:()=>activeProject&&leaveKnowledge(()=>setImportTarget({projectId:activeProject.id,boardId:b.id,boardName:b.name})) },
      {
        type: 'item',
        label: '重命名',
        onClick: () => setEditing({ kind: 'rename-board', id: b.id, value: b.name }),
      },
      { type: 'separator' },
      { type: 'item', label: '删除白板', danger: true, onClick: () => removeBoard(b) },
    ]);

  const cancelEdit = () => {
    if (busyRef.current) return;
    editingRef.current = null;
    setEditing(null);
  };
  const editTitle = editing?.kind === 'new-project' ? '新建项目'
    : editing?.kind === 'new-board' ? '新建白板' : '重命名';
  const nameDialog = editing && (
    <div className="settings-overlay" onMouseDown={cancelEdit}>
      <form className="settings-card project-name-dialog" role="dialog" aria-modal="true" aria-label={editTitle}
        onMouseDown={event => event.stopPropagation()}
        onSubmit={event => { event.preventDefault(); void commitEdit(); }}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Escape') { event.preventDefault(); cancelEdit(); }
          if (event.key === 'Tab') {
            const fields = [...event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)')];
            const current = fields.indexOf(document.activeElement as HTMLElement);
            if (fields.length) {
              event.preventDefault();
              fields[(current + (event.shiftKey ? -1 : 1) + fields.length) % fields.length].focus();
            }
          }
        }}>
        <h2>{editTitle}</h2>
      <input
        ref={editRef}
        className="input"
        aria-label="名称"
        disabled={busy}
        value={draft}
        placeholder="输入名称，回车确认"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      />
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="action-confirm-buttons">
          <button type="button" className="btn" onClick={cancelEdit} disabled={busy}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !draft.trim()}>保存</button>
        </div>
      </form>
    </div>
  );

  /* ── 首屏加载 ── */
  if (phase === 'loading') return <div className="screen-center">正在载入…</div>;

  const fullscreenExit = fullscreen && (
    <button type="button" className="fullscreen-exit" aria-label="退出全屏" title="退出全屏 (Esc)" onClick={() => void applyFullscreen(false)}>
      <Minimize2 size={17} aria-hidden="true" />
    </button>
  );

  if (phase === 'setup') {
    return (
      <div className={`board-surface${fullscreen ? ' is-fullscreen' : ''}`} style={surfaceStyle}>
        <TitleBar platform={platform} brand="脉络" onMenu={appMenu} menuOpen={menu?.source === 'titlebar'} onFullscreen={enterFullscreen} fullscreen={fullscreen} onSettings={() => setSettingsOpen(true)} />
        {fullscreenExit}
        <div className="screen-center">
          <div className="setup-card">
            <h1 className="setup-title">脉络</h1>
            <p className="setup-desc">
              每一块白板会存成一个文件夹，里面放着它的 Markdown 与树状结构。
              <br />
              请选择一个目录来存放这些内容（可随时在菜单里更改）。
            </p>
            <button className="btn btn-primary" onClick={chooseDir} disabled={busy}>
              选择存储目录
            </button>
            {error && <p className="error-text">{error}</p>}
          </div>
        </div>
        {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
        {settingsOpen && (
          <SettingsPanel settings={settings} platform={platform} storageRoot={root} storageBusy={busy} onChooseStorage={chooseDir} onChange={patchSettings} onClose={() => setSettingsOpen(false)} />
        )}
      </div>
    );
  }

  /* ── 主界面 ── */
  return (
    <div className={`board-surface${fullscreen ? ' is-fullscreen' : ''}`} style={surfaceStyle}>
      <TitleBar
        platform={platform}
        brand="脉络"
        onMenu={appMenu}
        menuOpen={menu?.source === 'titlebar'}
        onHome={() => navigateProject(null)}
        onSettings={() => setSettingsOpen(true)}
        onFullscreen={enterFullscreen}
        fullscreen={fullscreen}
        fadeToCanvas={!knowledgeOpen && !error && !archiveStatus}
        boardAction={activeBoard && !knowledgeOpen && <span className="titlebar-board-action" ref={setBoardActionSlot}/>}
        filter={!knowledgeOpen && !branchFocusActive && <TagFilter key={filterKey} tags={tags} active={tagFilter}
          onChange={ids => setTagFilters(old => ({ ...old, [filterKey]: ids }))} />}
        onToggleIndex={knowledgeOpen ? () => setKnowledgeIndexCollapsed(value => !value) : undefined}
        indexCollapsed={knowledgeIndexCollapsed}
        path={<ProjectPath path={knowledgeOpen ? [] : projectTrail} board={knowledgeOpen ? '知识库' : activeBoard?.name} onNavigate={navigateProject} />}
      />

      {(error || archiveStatus) && <div className={`error-bar${error ? '' : ' is-information'}`} role="status">{error || archiveStatus}</div>}

      <div className="workspace">
        {knowledgeOpen ? <KnowledgeLibrary boardId={activeBoard?.id} boardName={activeBoard?.name} boardPolicy={activeBoard?._sync_content_policy} indexCollapsed={knowledgeIndexCollapsed} {...knowledgeTarget} onEditingChange={onKnowledgeEditingChange} onNavigationReady={registerKnowledgeNavigation} onClose={() => { setKnowledgeOpen(false); setError(null); }} /> : activeBoard ? (
          <BoardCanvas
            key={`${activeBoard.id}:${boardGeneration}`}
            board={activeBoardRef.current ?? activeBoard}
            scope={canvasScope || root || ''}
            fullscreen={fullscreen}
            actionSlot={boardActionSlot} onBranchFocusChange={setBranchFocusActive}
            onChange={onCanvasChange} onViewportChange={onViewportChange} onFlush={flushBoards} saveState={saveState}
            guessMath={settings.guessMath}
            tags={tags}
            tagStore={layout.tags}
            tagFilter={tagFilter}
            onEditTags={node => setTagEdit({
              target: { kind: 'node', id: node.id, boardId: activeBoard.id, projectId: activeBoard.projectId },
              name: node.title, colorMark: colorTag(node.color),
            })}
            focusNode={focusNode && activeBoard.nodes.some((n) => n.id === focusNode.id) ? focusNode : null}
          />
        ) : (
          <ProjectCanvas
            key={JSON.stringify([canvasScope || root, activeProject?.id])}
            scope={canvasScope || root || ''}
            folderId={activeProject?.id ?? null}
            folderName={activeProject?.name}
            tiles={visibleTiles}
            relations={layout.relations}
            tags={tags}
            filtering={tagFilter.size > 0}
            disabled={busy || syncLocked || !!editing || !!coverEdit}
            readBoards={api.boardsList}
            previewTiles={previewTiles}
            onOpen={tile => {
              if (tile.kind === 'project') navigateProject(tile.row.id);
              else openBoard(tile.projectId, tile.row.id);
            }}
            onPlace={placeTile}
            onConnect={relation => relateCards(relation, true)}
            onBend={bendRelation}
            onLabel={(relation, label) => saveCatalog(async () => {
              setLayout(await api.projectCanvasLabel(activeProject?.id ?? null, relation, label, canvasScope));
            })}
            onRelationMenu={(event, relation) => openAt(event, [
              ...(relation.bend ? [{ type: 'item' as const, label: '拉直连线', onClick: () => void bendRelation(relation, null) }] : []),
              { type: 'item', label: '删除连线', danger: true, onClick: () => relateCards(relation, false) },
            ], { atPointer: true })}
            onFavorite={tile => toggleFavorite(tile.kind === 'project' ? 'projects' : 'boards', tile.row.id)}
            onWorkspaceAi={() => setWorkspaceAiOpen(true)}
            onMenu={(event, tile) => {
              if (!tile) openAt(event, createItems());
              else if (tile.kind === 'project') projectItemMenu(event, tile.row);
              else boardItemMenu(event, tile.row);
            }}
            addMenuOpen={menu?.source === 'create'}
            onAdd={event => activeProject ? openAt(event, createItems(), { source: 'create' }) : setEditing({ kind: 'new-project', parentId: null })}
          />
        )}
      </div>
      {fullscreenExit}
      {activeBoard&&!knowledgeOpen&&!branchFocusActive&&<button className={`board-save-state is-${saveState}`} title="内容自动保存 · Cmd/Ctrl+S立即保存" onClick={()=>void flushBoards().catch(e=>setError(String(e)))}>{saveState==='saved'?'已保存':saveState==='saving'?'保存中…':saveState==='error'?'保存失败 · 点击重试':'等待保存…'}</button>}
      {syncLocked&&<div className="sync-edit-lock" role="status">正在保存并同步资料…</div>}

      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
      {nameDialog}
      {deletion && <ConfirmAction message={deletion.message} confirmLabel={deletion.confirmLabel} onCancel={cancelDeletion} onConfirm={() => { const accept = deletion.accept; setDeletion(null); accept(); }} />}
      {importTarget&&<ConversationImport target={importTarget} onClose={()=>setImportTarget(undefined)} onImported={(board,rootNodeId)=>{
        routeGeneration.current++;
        pendingBoards.current.delete(board.id);
        setActiveBoard(board);
        const project = projects.find(p => p.id === board.projectId) ?? null;
        activeProjectRef.current = project; setActiveProject(project);
        setBoardGeneration(n => n + 1); setKnowledgeOpen(false); setImportTarget(undefined);
        if (rootNodeId) setFocusNode({ id: rootNodeId, nonce: Date.now() });
        void refreshBoards(board.projectId).catch(error => setError(`对话已保存，列表刷新未完成：${String(error)}`));
      }}/>}
      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} onJump={jumpTo} />
      <SnapshotPanel
        open={snapshotOpen}
        projectId={activeProject?.id ?? null}
        boardId={activeBoard?.id ?? null}
        boardName={activeBoard?.name ?? null}
        onClose={() => setSnapshotOpen(false)}
        onRestored={(board) => {pendingBoards.current.delete(board.id);setActiveBoard(board);setBoardGeneration(n=>n+1);}}
      />
      <ShortcutsHelp open={helpOpen} platform={platform} onClose={() => setHelpOpen(false)} />
      {coverEdit && <ProjectCoverPicker name={coverEdit.name} kind={coverEdit.target.kind} current={coverEdit.current}
        onClose={() => {
          const { trigger } = coverEdit;
          setCoverEdit(undefined);
          requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
        }} onSave={id => saveCover(coverEdit, id)} />}
      {tagEdit && <TagEditor key={tagKey(tagEdit.target)} title={tagEdit.name} tags={tags}
        assigned={assignedTags(layout.tags, tagEdit.target)} colorMark={tagEdit.colorMark}
        onClose={() => setTagEdit(undefined)}
        onSave={(ids, newTags) => saveTagDraft(tagEdit.target, ids, newTags)} />}
      {settingsOpen && (
        <SettingsPanel settings={settings} platform={platform} storageRoot={root} storageBusy={busy || syncLocked || knowledgeEditing.current} onChooseStorage={chooseDir} onChange={patchSettings} onClose={() => setSettingsOpen(false)} />
      )}

      {/* 应用内浮层阅读器（浏览器预览 / 开独立窗口失败时的回退） */}
      <ReaderOverlay key={`reader:${root ?? 'unconfigured'}`} guessMath={settings.guessMath} suspended={knowledgeOpen} />

      {/* AI 助手悬浮按钮（M5-1）：绑定当前白板 */}
      <AiFab
        key={`ai:${root ?? 'unconfigured'}`}
        projectId={activeProject?.id ?? null}
        boardId={activeBoard?.id ?? null}
        boardName={activeBoard?.name ?? null}
        suspended={knowledgeOpen || !activeBoard || branchFocusActive}
        onBoardSettings={()=>window.dispatchEvent(new CustomEvent('lumen:board-settings',{detail:activeBoard?.id}))}
      />
      <WorkspaceAssistant key={canvasScope} open={workspaceAiOpen} scope={canvasScope} onClose={() => setWorkspaceAiOpen(false)}
        context={{
          project: activeProject ? { id: activeProject.id, path: projectTrail.map(project => project.name).join(' / ') } : undefined,
          board: activeBoard ? { id: activeBoard.id, name: activeBoard.name } : undefined,
        }}
        onOpenLocation={location => location.boardId ? void openBoard(location.projectId, location.boardId) : navigateProject(location.projectId)} />
    </div>
  );
}
