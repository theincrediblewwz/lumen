import { useCallback, useEffect, useState } from 'react';
import { api, pickStorageDir, type BoardMeta, type ProjectMeta } from './api';

type Phase = 'loading' | 'setup' | 'ready';

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [root, setRoot] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [boards, setBoards] = useState<BoardMeta[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectMeta | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [newBoardName, setNewBoardName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* 启动：读取配置，判断是否需要引导选择存储目录 */
  useEffect(() => {
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

  const refreshProjects = useCallback(async () => {
    setProjects(await api.projectsList());
  }, []);

  const refreshBoards = useCallback(async (projectId: string) => {
    setBoards(await api.boardsList(projectId));
  }, []);

  /* ── 存储目录（M1-4） ── */
  const chooseDir = async () => {
    setError(null);
    const picked = await pickStorageDir();
    if (!picked) return;
    setBusy(true);
    try {
      const cfg = await api.configSetRoot(picked);
      setRoot(cfg.storage_root);
      await refreshProjects();
      setPhase('ready');
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /* ── 项目（M1-5） ── */
  const createProject = async () => {
    if (!newProjectName.trim()) return;
    setBusy(true);
    try {
      const created = await api.projectCreate(newProjectName);
      setNewProjectName('');
      await refreshProjects();
      setActiveProject(created);
      await refreshBoards(created.id);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeProject = async (p: ProjectMeta) => {
    if (!confirm(`删除项目「${p.name}」？该目录下的所有白板与 Markdown 都会被移除。`)) return;
    setBusy(true);
    try {
      await api.projectDelete(p.id);
      if (activeProject?.id === p.id) {
        setActiveProject(null);
        setBoards([]);
      }
      await refreshProjects();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /* ── 白板（M1-5） ── */
  const createBoard = async () => {
    if (!activeProject || !newBoardName.trim()) return;
    setBusy(true);
    try {
      await api.boardCreate(activeProject.id, newBoardName);
      setNewBoardName('');
      await refreshBoards(activeProject.id);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeBoard = async (b: BoardMeta) => {
    if (!activeProject) return;
    if (!confirm(`删除白板「${b.name}」？其中的 Markdown 文件会一并移除。`)) return;
    setBusy(true);
    try {
      await api.boardDelete(activeProject.id, b.id);
      await refreshBoards(activeProject.id);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const selectProject = async (p: ProjectMeta) => {
    setActiveProject(p);
    setError(null);
    try {
      await refreshBoards(p.id);
    } catch (e: unknown) {
      setError(String(e));
    }
  };

  /* ── 首次启动：引导选择存储目录 ── */
  if (phase === 'loading') {
    return <div className="screen-center">正在载入…</div>;
  }

  if (phase === 'setup') {
    return (
      <div className="screen-center">
        <div className="setup-card">
          <h1 className="setup-title">脉络</h1>
          <p className="setup-desc">
            每一块白板会存成一个文件夹，里面放着它的 Markdown 与树状结构。
            <br />
            请选择一个目录来存放这些内容（可随时在设置里更改）。
          </p>
          <button className="btn btn-primary" onClick={chooseDir} disabled={busy}>
            选择存储目录
          </button>
          {error && <p className="error-text">{error}</p>}
        </div>
      </div>
    );
  }

  /* ── 主界面 ── */
  return (
    <div className="board-surface">
      <header className="board-topbar">
        <span className="brand">脉络</span>
        <span className="meta" title={root ?? ''}>
          {root}
        </span>
        <button className="btn btn-ghost" onClick={chooseDir} disabled={busy}>
          更改目录
        </button>
      </header>

      {error && <div className="error-bar">{error}</div>}

      <div className="workspace">
        {/* 项目栏 */}
        <aside className="pane pane-projects">
          <div className="pane-head">项目</div>
          <ul className="list">
            {projects.map((p) => (
              <li
                key={p.id}
                className={`list-item ${activeProject?.id === p.id ? 'is-active' : ''}`}
                onClick={() => selectProject(p)}
              >
                <span className="list-title">{p.name}</span>
                <button
                  className="btn-icon"
                  title="删除项目"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeProject(p);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
            {projects.length === 0 && <li className="list-empty">还没有项目</li>}
          </ul>
          <div className="pane-foot">
            <input
              className="input"
              placeholder="新项目名"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createProject()}
            />
            <button className="btn" onClick={createProject} disabled={busy}>
              新建
            </button>
          </div>
        </aside>

        {/* 白板栏 */}
        <aside className="pane pane-boards">
          <div className="pane-head">{activeProject ? `白板 · ${activeProject.name}` : '白板'}</div>
          <ul className="list">
            {boards.map((b) => (
              <li key={b.id} className="list-item">
                <span className="list-title">{b.name}</span>
                <span className="list-meta">{b.updated_at.slice(0, 10)}</span>
                <button className="btn-icon" title="删除白板" onClick={() => removeBoard(b)}>
                  ×
                </button>
              </li>
            ))}
            {activeProject && boards.length === 0 && <li className="list-empty">还没有白板</li>}
            {!activeProject && <li className="list-empty">先选一个项目</li>}
          </ul>
          <div className="pane-foot">
            <input
              className="input"
              placeholder="新白板名"
              value={newBoardName}
              onChange={(e) => setNewBoardName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createBoard()}
              disabled={!activeProject}
            />
            <button className="btn" onClick={createBoard} disabled={busy || !activeProject}>
              新建
            </button>
          </div>
        </aside>

        {/* 画布占位：M2 会在这里挂 CanvasEngine */}
        <main className="board-canvas canvas-placeholder">
          <p className="placeholder-hint">
            {activeProject ? '选择或新建一块白板' : '从左侧选择一个项目'}
          </p>
        </main>
      </div>
    </div>
  );
}
