import { useCallback, useEffect, useRef, useState } from 'react';
import { api, pickStorageDir, type AppInfo, type BoardMeta, type ProjectMeta } from './api';
import { ContextMenu, type ContextMenuState } from './components/ContextMenu';
import { TitleBar } from './components/TitleBar';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState('');
  const editRef = useRef<HTMLInputElement>(null);

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
      setActiveProject(p);
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
      </div>
    );
  }

  /* ── 主界面 ── */
  return (
    <div className="board-surface">
      <TitleBar platform={platform} brand="脉络" onMenu={appMenu} />

      {error && <div className="error-bar">{error}</div>}

      <div className="workspace">
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

        {/* 白板栏：空白处右键 = 新建白板 */}
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
              <li key={b.id} className="list-item" onContextMenu={(e) => boardItemMenu(e, b)}>
                <span className="list-title">{b.name}</span>
                <span className="list-meta">{b.updated_at.slice(0, 10)}</span>
              </li>
            ))}
            {editing?.kind === 'new-board' && inlineEditor}
            {activeProject && boards.length === 0 && editing?.kind !== 'new-board' && (
              <li className="list-empty">右键此处新建白板</li>
            )}
            {!activeProject && <li className="list-empty">先选一个项目</li>}
          </ul>
        </aside>

        {/* 画布占位：M2 会在这里挂 CanvasEngine */}
        <main className="board-canvas canvas-placeholder">
          <p className="placeholder-hint">
            {activeProject ? '选择或新建一块白板' : '从左侧选择一个项目'}
          </p>
        </main>
      </div>

      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
