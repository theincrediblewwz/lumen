import { useEffect, useState } from 'react';
import { api } from './api';
import { ReaderView } from './components/ReaderView';
import { loadSettings, applySettings, subscribeSettings } from './settings';

/**
 * 独立阅读窗口的根组件（M4-4）。从 URL query 读取 project/board/path，
 * 通过 Tauri 命令拉取文档内容（后端做编码探测），再交给 ReaderView 渲染。
 *
 * 主题跟随软件主体（读取同一 localStorage 设置并 applySettings），保证阅读
 * 窗口与主窗口外观一致（ADR-027）。
 */
export function ReaderApp() {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get('project') ?? '';
  const boardId = params.get('board') ?? '';
  const path = params.get('path') ?? '';
  const title = params.get('title') ?? path.replace(/^docs\//, '').replace(/\.(md|markdown)$/i, '');

  const settings = loadSettings();
  const [platform, setPlatform] = useState<string>('');
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ok'; md: string } | { kind: 'error'; msg: string }
  >({ kind: 'loading' });

  // 应用软件主体的主题到本窗口（不启用原生玻璃：阅读窗用系统装饰、纯实色更稳），
  // 并跨窗口跟随主窗口的实时主题切换（M6-1）
  useEffect(() => {
    applySettings({ ...loadSettings(), glass: false });
    return subscribeSettings((s) => applySettings({ ...s, glass: false }));
  }, []);

  // 取平台：决定自绘标题栏用 macOS 红绿灯留白还是 Windows 三键
  useEffect(() => {
    api.appInfo().then((i) => setPlatform(i.platform)).catch(() => {});
  }, []);

  useEffect(() => {
    document.title = `${title} — 脉络 Lumen`;
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
      platform={platform}
      title={title}
      markdown={state.md}
      docKey={`${projectId}/${boardId}/${path}`}
      guessMath={settings.guessMath}
    />
  );
}

