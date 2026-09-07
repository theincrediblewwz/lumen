import { useEffect, useState } from 'react';
import { api } from './api';
import { ReaderView } from './components/ReaderView';

/**
 * 独立阅读窗口的根组件（M4-4）。从 URL query 读取 project/board/path，
 * 通过 Tauri 命令拉取文档内容（后端做编码探测），再交给 ReaderView 渲染。
 */
export function ReaderApp() {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get('project') ?? '';
  const boardId = params.get('board') ?? '';
  const path = params.get('path') ?? '';
  const title = params.get('title') ?? path.replace(/^docs\//, '').replace(/\.(md|markdown)$/i, '');

  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ok'; md: string } | { kind: 'error'; msg: string }
  >({ kind: 'loading' });

  useEffect(() => {
    document.title = `${title} — 脉络阅读`;
    let alive = true;
    api
      .docRead(projectId, boardId, path)
      .then((md) => alive && setState({ kind: 'ok', md }))
      .catch((e) => alive && setState({ kind: 'error', msg: String(e) }));
    return () => {
      alive = false;
    };
  }, [projectId, boardId, path, title]);

  if (state.kind === 'loading') {
    return <div className="reader-splash">正在打开《{title}》…</div>;
  }
  if (state.kind === 'error') {
    return <div className="reader-splash reader-splash-error">无法打开文档：{state.msg}</div>;
  }
  return (
    <ReaderView
      standalone
      title={title}
      markdown={state.md}
      docKey={`${projectId}/${boardId}/${path}`}
    />
  );
}
