import { useCallback, useEffect, useRef, useState } from 'react';
import { api, pickStorageDir, type AppInfo, type BoardFile, type BoardMeta, type BoardNode, type ProjectMeta } from './api';
import { ContextMenu, type ContextMenuState } from './components/ContextMenu';
import { TitleBar } from './components/TitleBar';
import { BoardCanvas } from './components/BoardCanvas';
import type { Viewport } from './canvas/CanvasEngine';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { SettingsPanel } from './components/SettingsPanel';
import { loadSettings, saveSettings, applySettings, type Settings } from './settings';

type Phase = 'loading' | 'setup' | 'ready';

/** 内联编辑状态：在某个列表里就地新建 / 重命名 */
type Editing =
  | null
  | { kind: 'new-project' }
  | { kind: 'new-board' }
  | { kind: 'rename-project'; id: string; value: string }
  | { kind: 'rename-board'; id: string; value: string };

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [platform, setPlatform] = useState<string>('');
  const [root, setRoot] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [boards, setBoards] = useState<BoardMeta[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectMeta | null>(null);
  const [activeBoard, setActiveBoard] = useState<BoardFile | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState('');
  const editRef = useRef<HTMLInputElement>(null);

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

  /* F11 切换全屏；Esc 退出全屏 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === 'Escape' && fullscreen) {
        applyFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen, toggleFullscreen, applyFullscreen]);

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

  /* ── 打开白板：加载 board.json 到画布 ── */
  const openBoard = useCallback(
    (projectId: string, boardId: string) =>
      withBusy(async () => {
        const bf = await api.boardLoad(projectId, boardId);
        setActiveBoard(bf);
      }),
    [], // withBusy 稳定
  );

  /* ── 画布变更：本地即时更新 + 防抖落盘（DESIGN §6.5） ── */
  const onCanvasChange = useCallback(
    (nodes: BoardNode[], viewport: Viewport) => {
      setActiveBoard((prev) => {
        if (!prev) return prev;
        const next: BoardFile = { ...prev, nodes, viewport };
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          api.boardSave(next).catch((e) => setError(String(e)));
        }, 600);
        return next;
      });
    },
    [],
  );

  const withBusy = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /* ── 存储目录 ── */
  const chooseDir = () =>
    withBusy(async () => {
      const picked = await pickStorageDir();
      if (!picked) return;
      const cfg = await api.configSetRoot(picked);
      setRoot(cfg.storage_root);
      setActiveProject(null);
      setBoards([]);
      await refreshProjects();
      setPhase('ready');
    });

  /* ── 提交内联编辑 ── */
  const commitEdit = () =>
    withBusy(async () => {
      const name = draft.trim();
      const cur = editing;
      setEditing(null);
      if (!cur || !name) return;

      if (cur.kind === 'new-project') {
        const created = await api.projectCreate(name);
        await refreshProjects();
        setActiveProject(created);
        await refreshBoards(created.id);
      } else if (cur.kind === 'new-board') {
        if (!activeProject) return;
        await api.boardCreate(activeProject.id, name);
        await refreshBoards(activeProject.id);
      } else if (cur.kind === 'rename-project') {
        await api.projectRename(cur.id, name);
        await refreshProjects();
        if (activeProject?.id === cur.id) setActiveProject({ ...activeProject, name });
      } else if (cur.kind === 'rename-board') {
        if (!activeProject) return;
        await api.boardRename(activeProject.id, cur.id, name);
        await refreshBoards(activeProject.id);
      }
    });

  const selectProject = (p: ProjectMeta) =>
    withBusy(async () => {
      // 再次点击已选中的项目 = 取消选中（白板栏随之收起）
      if (activeProject?.id === p.id) {
        setActiveProject(null);
        setActiveBoard(null);
        setBoards([]);
        return;
      }
      setActiveProject(p);
      setActiveBoard(null);
      await refreshBoards(p.id);
    });

  const removeProject = (p: ProjectMeta) =>
    withBusy(async () => {
      if (!confirm(`删除项目「${p.name}」？该目录下的所有白板与 Markdown 都会被移除。`)) return;
      await api.projectDelete(p.id);
      if (activeProject?.id === p.id) {
        setActiveProject(null);
        setBoards([]);
      }
      await refreshProjects();
    });

  const removeBoard = (b: BoardMeta) =>
    withBusy(async () => {
      if (!activeProject) return;
      if (!confirm(`删除白板「${b.name}」？其中的 Markdown 文件会一并移除。`)) return;
      await api.boardDelete(activeProject.id, b.id);
      if (activeBoard?.id === b.id) setActiveBoard(null);
      await refreshBoards(activeProject.id);
    });

  /* ── 右键菜单构造 ── */
  const openAt = (e: React.MouseEvent, items: ContextMenuState['items']) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const appMenu = (e: React.MouseEvent) =>
    openAt(e, [
      { type: 'info', text: '脉络 Lumen', sub: root ?? '未设置存储目录' },
      { type: 'separator' },
      { type: 'item', label: '设置…', onClick: () => setSettingsOpen(true) },
      { type: 'item', label: '进入全屏  F11', onClick: () => applyFullscreen(true) },
      { type: 'separator' },
      { type: 'item', label: '更改存储目录…', onClick: chooseDir },
    ]);

  const projectsPaneMenu = (e: React.MouseEvent) =>
    openAt(e, [{ type: 'item', label: '新建项目', onClick: () => setEditing({ kind: 'new-project' }) }]);

  const projectItemMenu = (e: React.MouseEvent, p: ProjectMeta) =>
    openAt(e, [
      { type: 'item', label: '打开', onClick: () => selectProject(p) },
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
    ]);

  const boardItemMenu = (e: React.MouseEvent, b: BoardMeta) =>
    openAt(e, [
      { type: 'item', label: '打开', onClick: () => activeProject && openBoard(activeProject.id, b.id) },
      {
        type: 'item',
        label: '重命名',
        onClick: () => setEditing({ kind: 'rename-board', id: b.id, value: b.name }),
      },
      { type: 'separator' },
      { type: 'item', label: '删除白板', danger: true, onClick: () => removeBoard(b) },
    ]);

  const inlineEditor = (
    <li className="list-item is-editing">
      <input
        ref={editRef}
        className="input inline-input"
        value={draft}
        placeholder="输入名称，回车确认"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitEdit();
          else if (e.key === 'Escape') setEditing(null);
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
          <SettingsPanel settings={settings} platform={platform} onChange={patchSettings} onClose={() => setSettingsOpen(false)} />
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
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          sidebarCollapsed={sidebarCollapsed}
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

      {error && <div className="error-bar">{error}</div>}

      <div className="workspace">
        {/* 侧栏（项目 + 白板）：由标题栏三横线开关统一收起/展开。
            始终挂载，用 is-collapsed 类做宽度过渡，收起/展开都有动画。 */}
        <div
          className={`sidebar glass-surface${sidebarCollapsed ? ' is-collapsed' : ''}${
            activeProject ? ' has-boards' : ''
          }`}
        >
          <div className="sidebar-inner">
            {/* 项目栏：空白处右键 = 新建项目 */}
            <aside className="pane pane-projects">
              <div className="pane-head">
                <span>项目</span>
                <button className="pane-add" title="新建项目" onClick={() => setEditing({ kind: 'new-project' })}>
                  ＋
                </button>
              </div>
              <ul className="list" onContextMenu={projectsPaneMenu}>
                {projects.map((p) => (
                  <li
                    key={p.id}
                    className={`list-item ${activeProject?.id === p.id ? 'is-active' : ''}`}
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
            </aside>

            {/* 白板栏：仅在选中项目时出现；空白处右键 = 新建白板 */}
            {activeProject && (
            <aside className="pane pane-boards">
              <div className="pane-head">
                <span>{activeProject ? `白板 · ${activeProject.name}` : '白板'}</span>
                {activeProject && (
                  <button className="pane-add" title="新建白板" onClick={() => setEditing({ kind: 'new-board' })}>
                    ＋
                  </button>
                )}
              </div>
              <ul className="list" onContextMenu={activeProject ? boardsPaneMenu : undefined}>
                {boards.map((b) => (
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
        {activeBoard ? (
          <BoardCanvas key={activeBoard.id} board={activeBoard} onChange={onCanvasChange} />
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

      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
      {settingsOpen && (
        <SettingsPanel settings={settings} platform={platform} onChange={patchSettings} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
