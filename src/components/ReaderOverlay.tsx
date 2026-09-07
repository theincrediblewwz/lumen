import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { ReaderView } from './ReaderView';
import { OPEN_READER_EVENT, type OpenReaderArgs } from '../reader/windowManager';

/**
 * 应用内浮层阅读器（M4-4 回退 / 浏览器预览）。
 * 监听 windowManager 派发的 open-reader 事件（当不在 Tauri、或开独立窗口失败时触发），
 * 拉取文档内容并以浮层呈现 ReaderView。真机 Tauri 下正常路径走独立窗口，不经这里。
 */
export function ReaderOverlay() {
  const [args, setArgs] = useState<OpenReaderArgs | null>(null);
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ok'; md: string } | { kind: 'error'; msg: string }
  >({ kind: 'loading' });

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenReaderArgs>).detail;
      setArgs(detail);
      setState({ kind: 'loading' });
    };
    window.addEventListener(OPEN_READER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_READER_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!args) return;
    let alive = true;
    api
      .docRead(args.projectId, args.boardId, args.path)
      .then((md) => alive && setState({ kind: 'ok', md }))
      .catch((err) => alive && setState({ kind: 'error', msg: String(err) }));
    return () => {
      alive = false;
    };
  }, [args]);

  useEffect(() => {
    if (!args) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setArgs(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [args]);

  if (!args) return null;

  return createPortal(
    <div className="reader-overlay" onMouseDown={(e) => e.target === e.currentTarget && setArgs(null)}>
      {state.kind === 'ok' ? (
        <ReaderView
          title={args.title}
          markdown={state.md}
          docKey={`${args.projectId}/${args.boardId}/${args.path}`}
          onClose={() => setArgs(null)}
        />
      ) : (
        <div className="reader" data-reader-theme="light">
          <div className="reader-splash">
            {state.kind === 'error' ? `无法打开文档：${state.msg}` : `正在打开《${args.title}》…`}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
