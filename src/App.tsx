import { useCallback, useEffect, useRef, useState } from 'react';
import { api, pickStorageDir, type AppInfo, type BoardEdge, type BoardFile, type BoardMeta, type BoardNode, type ProjectMeta } from './api';
import { ContextMenu, type ContextMenuState } from './components/ContextMenu';
import { TitleBar } from './components/TitleBar';
import { ConfirmAction } from './components/ConfirmAction';
import { BoardCanvas } from './components/BoardCanvas';
import { ReaderOverlay } from './components/ReaderOverlay';
import { AiFab } from './components/AiFab';
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

type Phase = 'loading' | 'setup' | 'ready';

/** 内联编辑状态：在某个列表里就地新建 / 重命名 */
type Editing =
  | null
  | { kind: 'new-project' }
  | { kind: 'new-board' }
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
  const [platform, setPlatform] = useState<string>('');
  const [root, setRoot] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [boards, setBoards] = useState<BoardMeta[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectMeta | null>(null);
  const [activeBoard, setActiveBoard] = useState<BoardFile | null>(null);
  const [boardsExpanded, setBoardsExpanded] = useState(true);
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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingBoards = useRef(new Map<string,BoardFile>());
  const pendingSave = useRef<Promise<void>>(Promise.resolve());
  const activeBoardRef = useRef(activeBoard);
  activeBoardRef.current = activeBoard;
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

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [menu, setMenu] = useState<ContextMenuState | null>(null);
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
    await pendingSave.current;
    for(const [id,board] of [...pendingBoards.current]) {
      const save=api.boardSave(board);pendingSave.current=save;
      try { await save; if(pendingBoards.current.get(id)===board)pendingBoards.current.delete(id); }
      finally { pendingSave.current=Promise.resolve(); }
    }
  },[]);
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
      if(!window.dispatchEvent(new Event('lumen:before-window-close',{cancelable:true}))){event.preventDefault();return;}
      if(knowledgeEditing.current){event.preventDefault();setError('当前写作尚未保存，请保存或取消写作后再关闭窗口。');return;}
      if(closing){event.preventDefault();return;}
      closing=true;
      // Tauri awaits this handler then destroys the window unless prevented.
      try{(document.activeElement as HTMLElement|null)?.blur();await Promise.resolve();await flushBoards();}
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
      try {
        await flushBoards();
        const projects=await api.projectsList();
        if(request!==generation)return;
        setProjects(projects);
        const current=activeBoardRef.current;
        if(current) {
          const project=projects.find(p=>p.id===current.projectId)??null;
          setActiveProject(project);
          const boards=project?await api.boardsList(project.id):[];
          if(request!==generation)return;setBoards(boards);
          const next=boards.some(b=>b.id===current.id)?await api.boardLoad(current.projectId,current.id):null;
          if(request!==generation)return;
          activeBoardRef.current=next;setActiveBoard(next);setBoardGeneration(n=>n+1);
        }
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
  },[flushBoards]);

  /* 启动：读平台信息 + 配置 */
  useEffect(() => {
    api.appInfo().then((i: AppInfo) => setPlatform(i.platform)).catch(() => {});
    api
      .configGet()
      .then(async (cfg) => {
        if (!cfg.storage_root) {
          setPhase('setup');
          return;
        }
        setRoot(cfg.storage_root);
        setProjects(await api.projectsList());
        setPhase('ready');
      })
      .catch((e: unknown) => {
        setError(String(e));
        setPhase('setup');
      });
  }, []);

  /* 屏蔽 WebView 自带的原生右键菜单（刷新/打印/另存为…）。
     应用内的右键交互由各元素的 onContextMenu 显式弹出，不受影响。 */
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    window.addEventListener('contextmenu', block);
    return () => window.removeEventListener('contextmenu', block);
  }, []);

  /* ── 全屏模式 ── */
  const applyFullscreen = useCallback((on: boolean) => {
    setFullscreen(on);
    getCurrentWindow().setFullscreen(on).catch(() => {});
  }, []);
  const toggleFullscreen = useCallback(() => {
    setFullscreen((cur) => {
      const next = !cur;
      getCurrentWindow().setFullscreen(next).catch(() => {});
      return next;
    });
  }, []);

  /* 全局快捷键（M6-9）：全屏 / 搜索 / 帮助；Esc 退出全屏。画布级快捷键在 BoardCanvas 内处理 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchShortcut(e, shortcut('fullscreen')!, { mac })) {
        e.preventDefault();
        toggleFullscreen();
      } else if (matchShortcut(e, shortcut('search')!, { mac })) {
        // 全局搜索（M6-6）——在输入框里也允许（方便随时唤出）
        e.preventDefault();
        setSearchOpen((v) => !v);
      } else if (!isEditableTarget(e.target) && matchShortcut(e, shortcut('help')!, { mac })) {
        // 快捷键帮助（Shift+/ 即 ?）；打字时不触发
        e.preventDefault();
        setHelpOpen((v) => !v);
      } else if (e.key === 'Escape' && fullscreen) {
        applyFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen, toggleFullscreen, applyFullscreen, mac]);

  useEffect(() => {
    if (editing) {
      setDraft(
        editing.kind === 'rename-project' || editing.kind === 'rename-board' ? editing.value : '',
      );
      // 等 DOM 渲染出输入框再聚焦
      requestAnimationFrame(() => editRef.current?.focus());
    }
  }, [editing]);

  const refreshProjects = useCallback(async () => {
    setProjects(await api.projectsList());
  }, []);
  const refreshBoards = useCallback(async (projectId: string) => {
    setBoards(await api.boardsList(projectId));
  }, []);

  // ── AI 引用跳转（M5-6）：切到目标白板并高亮节点 ──
  const jumpTo = useCallback(
    (projectId: string, boardId: string, nodeId: string | null) =>
      leaveKnowledge(() => void withBusy(async () => {
        // 若目标项目/白板不是当前的，切过去
        await flushBoards();
        setActiveBoard((prevBoard) => {
          if (prevBoard && prevBoard.id === boardId) return prevBoard;
          return prevBoard; // 实际加载在下面 async
        });
        const projs = await api.projectsList();
        const proj = projs.find((p) => p.id === projectId) ?? null;
        if (proj) {
          setActiveProject(proj);
          setBoards(await api.boardsList(projectId));
        }
        const bf = await api.boardLoad(projectId, boardId);
        setActiveBoard(bf);
        setSidebarCollapsed(true); // 给画布腾地方
        // 等画布挂载后再定位（用 nonce 保证每次都触发）；无 nodeId 只切白板不高亮
        if (nodeId) {
          requestAnimationFrame(() =>
            setFocusNode({ id: nodeId, nonce: Date.now() }),
          );
        }
      })),
    [leaveKnowledge, flushBoards],
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
  const openBoard = useCallback(
    (projectId: string, boardId: string) =>
      leaveKnowledge(() => void withBusy(async () => {
        // 打开前自动存一份快照（DESIGN §FR-8.4：去重、保留最近 20 份）；失败不阻断打开
        await flushBoards();
        api.snapshotCreate(projectId, boardId, false).catch(() => {});
        const bf = await api.boardLoad(projectId, boardId);
        setActiveBoard(bf);
      })),
    [leaveKnowledge, flushBoards],
  );

  /* ── 画布变更：本地即时更新 + 防抖落盘（DESIGN §6.5） ── */
  const onCanvasChange = useCallback(
    (nodes: BoardNode[], edges: BoardEdge[], viewport: Viewport) => {
      if(syncLockRef.current)return;
      const prev=activeBoardRef.current;if(!prev)return;
      const next:BoardFile={...prev,nodes,edges,viewport};
      activeBoardRef.current=next;setActiveBoard(next);pendingBoards.current.set(next.id,next);
      if(saveTimer.current)clearTimeout(saveTimer.current);
      saveTimer.current=setTimeout(()=>{void flushBoards().catch(e=>setError(String(e)));},600);
    },
    [flushBoards],
  );

  const withBusy = async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setArchiveStatus(null);
    try {
      await fn();
    } catch (e: unknown) {
      setArchiveStatus(null);
      setError(String(e));
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
      setRoot(cfg.storage_root);
      setActiveProject(null);
      activeBoardRef.current = null;
      setActiveBoard(null);
      setKnowledgeOpen(false);
      setKnowledgeTarget({});
      setBoards([]);
      await refreshProjects();
      setPhase('ready');
    });

  /* ── 提交内联编辑 ── */
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
          const created = await api.projectCreate(name);
          finish(); setProjects(rows => [...rows, created]);
          activeBoardRef.current = null; setActiveBoard(null);
          setActiveProject(created); setBoards([]); setBoardsExpanded(true);
        });
      } else if (cur.kind === 'new-board') {
        if (!activeProject) throw new Error('请先选择项目');
        const created = await api.boardCreate(activeProject.id, name);
        finish(); setBoards(rows => [...rows, created]);
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
            activeBoardRef.current = renamed; setActiveBoard(renamed);
          }
        });
      }
    });
    editSubmitting.current = false;
    if (editingRef.current === cur) editRef.current?.focus();
  };

  const selectProject = (p: ProjectMeta) =>
    leaveKnowledge(() => void withBusy(async () => {
      await flushBoards();
      // Navigation visibility is independent of the selected board and its data.
      if (activeProject?.id === p.id) {
        if (!knowledgeOpen) setBoardsExpanded(v => !v);
        return;
      }
      setBoardsExpanded(true);
      setActiveProject(p);
      activeBoardRef.current = null;
      setActiveBoard(null);
      await refreshBoards(p.id);
    }));

  const removeProject = (p: ProjectMeta) => setDeletion({
    message: `删除项目「${p.name}」？其中的白板与挂载资料都会被移除。知识库内容保留。`,
    accept: () => void withBusy(() => withBoardEditLock(async () => {
      await api.projectDelete(p.id);
      if (activeProject?.id === p.id) {
        setActiveProject(null);
        activeBoardRef.current = null; setActiveBoard(null);
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
      if (activeBoardRef.current?.id === b.id) { activeBoardRef.current = null; setActiveBoard(null); }
      await refreshBoards(projectId);
    })) });
  };

  /* ── 右键菜单构造 ── */
  const openAt = (e: React.MouseEvent, items: ContextMenuState['items']) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
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
      setRoot(cfg.storage_root); setActiveProject(null); activeBoardRef.current = null; setActiveBoard(null);
      setKnowledgeOpen(false); setKnowledgeTarget({}); setBoards([]); await refreshProjects(); setPhase('ready');
      setArchiveStatus(warnings.length ? `已打开恢复的资料库。${warnings.join('、')}未能写入本机偏好，备份中的记录仍保留。` : '已打开恢复的资料库，原资料目录保留。');
    }) });
  });

  const appMenu = (e: React.MouseEvent) =>
    openAt(e, [
      { type: 'info', text: '脉络 Lumen' },
      { type: 'separator' },
      { type: 'item', label: '全局搜索  Ctrl/Cmd+K', onClick: () => setSearchOpen(true) },
      { type: 'group', label: '导入', items: [
        {type:'item',label:'项目/全库资料包（恢复到新目录）…',onClick:restoreLibrary},
        {type:'item',label:'白板资料包…',disabled:!activeProject,onClick:()=>activeProject&&leaveKnowledge(()=>void withBusy(async()=>{const board=await importBoardPackage(activeProject.id);if(board){await refreshBoards(activeProject.id);activeBoardRef.current=board;setActiveBoard(board);setBoardGeneration(n=>n+1);}}))},
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
      { type: 'group', label: '视图与帮助', items: [
        { type: 'item', label: fullscreen ? '退出全屏  Esc' : '进入全屏  F11', onClick: () => applyFullscreen(!fullscreen) },
        { type: 'item', label: '快捷键帮助  ?', onClick: () => setHelpOpen(true) },
      ] },
      { type: 'item', label: '设置…', onClick: () => setSettingsOpen(true) },
    ]);

  const projectsPaneMenu = (e: React.MouseEvent) =>
    openAt(e, [{ type: 'item', label: '新建项目', onClick: () => setEditing({ kind: 'new-project' }) }]);

  const projectItemMenu = (e: React.MouseEvent, p: ProjectMeta) =>
    openAt(e, [
      { type: 'item', label: '打开', onClick: () => selectProject(p) },
      { type: 'item', label: '导出完整项目资料包…', onClick: () => exportLibrary(p) },
      {
        type: 'item',
        label: '重命名',
        onClick: () => setEditing({ kind: 'rename-project', id: p.id, value: p.name }),
      },
      { type: 'separator' },
      { type: 'item', label: '删除项目', danger: true, onClick: () => removeProject(p) },
    ]);

  const boardsPaneMenu = (e: React.MouseEvent) =>
    openAt(e, [
      {
        type: 'item',
        label: '新建白板',
        disabled: !activeProject,
        onClick: () => activeProject && setEditing({ kind: 'new-board' }),
      },
      { type:'item',label:'从对话新建白板…',disabled:!activeProject,onClick:()=>activeProject&&leaveKnowledge(()=>setImportTarget({projectId:activeProject.id})) },
    ]);

  const boardItemMenu = (e: React.MouseEvent, b: BoardMeta) =>
    openAt(e, [
      { type: 'item', label: '打开', onClick: () => activeProject && openBoard(activeProject.id, b.id) },
      { type:'item',label:'导入对话生成树…',onClick:()=>activeProject&&leaveKnowledge(()=>setImportTarget({projectId:activeProject.id,boardId:b.id,boardName:b.name})) },
      {
        type: 'item',
        label: '重命名',
        onClick: () => setEditing({ kind: 'rename-board', id: b.id, value: b.name }),
      },
      { type: 'separator' },
      { type: 'item', label: '删除白板', danger: true, onClick: () => removeBoard(b) },
    ]);

  const inlineEditor = (
    <li key={editing && 'id' in editing ? editing.id : editing?.kind} className="list-item is-editing">
      <input
        ref={editRef}
        className="input inline-input"
        aria-label="名称"
        disabled={busy}
        value={draft}
        placeholder="输入名称，回车确认"
        onChange={(e) => setDraft(e.target.value)}
        onClick={e => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          if (e.key === 'Enter') { e.preventDefault(); void commitEdit(); }
          else if (e.key === 'Escape') { e.preventDefault(); editingRef.current = null; setEditing(null); }
        }}
        onBlur={() => commitEdit()}
      />
    </li>
  );

  /* ── 首屏加载 ── */
  if (phase === 'loading') return <div className="screen-center">正在载入…</div>;

  if (phase === 'setup') {
    return (
      <div className="board-surface">
        <TitleBar platform={platform} brand="脉络" onMenu={appMenu} />
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
    <div className={`board-surface${fullscreen ? ' is-fullscreen' : ''}`}>
      {!fullscreen && (
        <TitleBar
          platform={platform}
          brand="脉络"
          onMenu={appMenu}
          onToggleSidebar={() => knowledgeOpen ? setKnowledgeIndexCollapsed(v => !v) : setSidebarCollapsed(v => !v)}
          sidebarCollapsed={knowledgeOpen ? knowledgeIndexCollapsed : sidebarCollapsed}
        />
      )}

      {fullscreen && (
        <button
          type="button"
          className="fullscreen-exit"
          title="退出全屏  Esc"
          onClick={() => applyFullscreen(false)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M6 2H2v4M14 6V2h-4M10 14h4v-4M2 10v4h4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>退出全屏</span>
        </button>
      )}

      {(error || archiveStatus) && <div className={`error-bar${error ? '' : ' is-information'}`} role="status">{error || archiveStatus}</div>}

      <div className="workspace">
        {/* 侧栏（项目 + 白板）：由标题栏三横线开关统一收起/展开。
            始终挂载，用 is-collapsed 类做宽度过渡，收起/展开都有动画。 */}
        <div
          hidden={knowledgeOpen}
          className={`sidebar glass-surface${sidebarCollapsed ? ' is-collapsed' : ''}${
            activeProject && boardsExpanded ? ' has-boards' : ''
          }`}
        >
          <div className="sidebar-inner">
            {/* 项目栏：空白处右键 = 新建项目 */}
            <aside className="pane pane-projects" onClick={e => {
              if (!(e.target as HTMLElement).closest('li,button,input')) setBoardsExpanded(false);
            }}>
              <div className="pane-head">
                <span>项目</span>
                <button className="pane-add" title="新建项目" onClick={() => setEditing({ kind: 'new-project' })}>
                  ＋
                </button>
              </div>
              <ul className="list" onContextMenu={projectsPaneMenu}>
                {projects.map((p) => editing?.kind === 'rename-project' && editing.id === p.id ? inlineEditor : (
                  <li
                    key={p.id}
                    className={`list-item ${activeProject?.id === p.id ? 'is-active' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-expanded={activeProject?.id === p.id && boardsExpanded}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectProject(p); } }}
                    onClick={() => selectProject(p)}
                    onContextMenu={(e) => projectItemMenu(e, p)}
                  >
                    <span className="list-title">{p.name}</span>
                  </li>
                ))}
                {editing?.kind === 'new-project' && inlineEditor}
                {projects.length === 0 && editing?.kind !== 'new-project' && (
                  <li className="list-empty">右键此处新建项目</li>
                )}
              </ul>
              <button className={`knowledge-nav${knowledgeOpen ? ' is-active' : ''}`} aria-pressed={knowledgeOpen} onClick={() => { if (knowledgeOpen) leaveKnowledge(); else { setKnowledgeTarget({}); setKnowledgeOpen(true); } }}>知识库</button>
            </aside>

            {/* 白板栏：仅在选中项目时出现；空白处右键 = 新建白板 */}
            {activeProject && boardsExpanded && (
            <aside className="pane pane-boards">
              <div className="pane-head">
                <span>{activeProject ? `白板 · ${activeProject.name}` : '白板'}</span>
                {activeProject && (
                  <button className="pane-add" title="新建白板" aria-haspopup="menu" onClick={boardsPaneMenu}>
                    ＋
                  </button>
                )}
              </div>
              <ul className="list" onContextMenu={activeProject ? boardsPaneMenu : undefined}>
                {boards.map((b) => editing?.kind === 'rename-board' && editing.id === b.id ? inlineEditor : (
                  <li
                    key={b.id}
                    className={`list-item ${activeBoard?.id === b.id ? 'is-active' : ''}`}
                    onClick={() => activeProject && openBoard(activeProject.id, b.id)}
                    onContextMenu={(e) => boardItemMenu(e, b)}
                  >
                    <span className="list-title">{b.name}</span>
                    <span className="list-meta">{b.updated_at.slice(0, 10)}</span>
                  </li>
                ))}
                {editing?.kind === 'new-board' && inlineEditor}
                {activeProject && boards.length === 0 && editing?.kind !== 'new-board' && (
                  <li className="list-empty">右键此处新建白板</li>
                )}
              </ul>
            </aside>
            )}
          </div>
        </div>

        {/* 画布区：挂 CanvasEngine（M2-2 / M2-3） */}
        {knowledgeOpen ? <KnowledgeLibrary boardId={activeBoard?.id} boardName={activeBoard?.name} boardPolicy={activeBoard?._sync_content_policy} indexCollapsed={knowledgeIndexCollapsed} {...knowledgeTarget} onEditingChange={onKnowledgeEditingChange} onNavigationReady={registerKnowledgeNavigation} onClose={() => { setKnowledgeOpen(false); setError(null); }} /> : activeBoard ? (
          <BoardCanvas
            key={`${activeBoard.id}:${boardGeneration}`}
            board={activeBoard}
            onChange={onCanvasChange}
            edgeStyle={settings.edgeStyle ?? 'curved'}
            guessMath={settings.guessMath}
            focusNode={focusNode && activeBoard.nodes.some((n) => n.id === focusNode.id) ? focusNode : null}
            onBlankClick={() => { setSidebarCollapsed(true); setBoardsExpanded(false); }}
          />
        ) : (
          <main className="board-canvas canvas-placeholder">
            <p className="placeholder-hint">
              {!activeProject
                ? '从左侧选择一个项目'
                : boards.length === 0
                  ? '右键白板栏空白处 · 新建一块白板'
                  : '选择一块白板打开画布'}
            </p>
          </main>
        )}
      </div>
      {syncLocked&&<div className="sync-edit-lock" role="status">正在保存并同步资料…</div>}

      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
      {deletion && <ConfirmAction message={deletion.message} confirmLabel={deletion.confirmLabel} onCancel={cancelDeletion} onConfirm={() => { const accept = deletion.accept; setDeletion(null); accept(); }} />}
      {importTarget&&<ConversationImport target={importTarget} onClose={()=>setImportTarget(undefined)} onImported={(board,rootNodeId)=>{
        pendingBoards.current.delete(board.id);activeBoardRef.current=board;setActiveBoard(board);setActiveProject(projects.find(p=>p.id===board.projectId)??activeProject);setBoardGeneration(n=>n+1);setKnowledgeOpen(false);setSidebarCollapsed(false);setBoardsExpanded(true);setImportTarget(undefined);if(rootNodeId)setFocusNode({id:rootNodeId,nonce:Date.now()});void refreshBoards(board.projectId).catch(e=>setError(`对话已保存，列表刷新未完成：${String(e)}`));
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
        suspended={knowledgeOpen}
      />
    </div>
  );
}
