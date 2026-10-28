import { useEffect, useState } from 'react';
import { api } from './api';
import { DocumentReaderView } from './components/DocumentReaderView';
import { documentPayload } from './documents/client';
import type { DocumentPayload } from './documents/core';
import { loadSettings, applySettings, subscribeSettings } from './settings';
import { REFRESH_READER_EVENT, type OpenReaderArgs } from './reader/windowManager';
import { loadWritePolicy } from './ai/boardOperations';

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
    { kind: 'loading' } | { kind: 'ok'; payload: DocumentPayload } | { kind: 'error'; msg: string }
  >({ kind: 'loading' });

  // 应用软件主体的主题到本窗口（不启用原生玻璃：阅读窗用系统装饰、纯实色更稳），
  // 并跨窗口跟随主窗口的实时主题切换（M6-1）
  useEffect(() => {
    applySettings({ ...loadSettings(), glass: false }, platform);
    return subscribeSettings((s) => applySettings({ ...s, glass: false }, platform));
  }, [platform]);

  // 取平台：决定自绘标题栏用 macOS 红绿灯留白还是 Windows 三键
  useEffect(() => {
    api.appInfo().then((i) => setPlatform(i.platform)).catch(() => {});
    // macOS：本窗口无边框，需应用原生材质+圆角（非 macOS 为空操作）
    void api.applyWindowCorners?.().catch(() => {});
  }, []);

  useEffect(() => {
    document.title = `${title} — 脉络 Lumen`;
    let alive = true,epoch=0;const stops:Array<()=>void>=[];
    const scope=loadWritePolicy().then(policy=>policy.scope??undefined);
    const read=()=>{const current=++epoch;void scope.then(s=>documentPayload(projectId,boardId,path,s)).then(payload=>{if(alive&&current===epoch)setState({kind:'ok',payload});}).catch(e=>{if(alive&&current===epoch)setState({kind:'error',msg:String(e)});});};
    const refresh=(target?:OpenReaderArgs)=>{if(!target||(target.projectId===projectId&&target.boardId===boardId&&target.path===path))read();};
    const local=(event:Event)=>refresh((event as CustomEvent<OpenReaderArgs>).detail);
    window.addEventListener(REFRESH_READER_EVENT,local);read();
    if('__TAURI_INTERNALS__' in window)void import('@tauri-apps/api/event').then(async({listen})=>{
      const retain=(stop:()=>void)=>{if(alive)stops.push(stop);else stop();};
      await Promise.all([listen<OpenReaderArgs>(REFRESH_READER_EVENT,e=>refresh(e.payload)).then(retain),listen('lumen://library-changed',()=>read()).then(retain)]);
    }).catch(e=>{if(alive)setState({kind:'error',msg:`无法监听文档更新：${String(e)}`});});
    return () => {
      alive = false;epoch++;stops.forEach(stop=>stop());window.removeEventListener(REFRESH_READER_EVENT,local);
    };
  }, [projectId, boardId, path, title]);

  if (state.kind === 'loading') {
    return <div className="reader-splash">正在打开《{title}》…</div>;
  }
  if (state.kind === 'error') {
    return <div className="reader-splash reader-splash-error">无法打开文档：{state.msg}</div>;
  }
  return (
    <DocumentReaderView
      standalone
      platform={platform}
      title={title}
      payload={state.payload}
      docKey={`${projectId}/${boardId}/${path}`}
      guessMath={settings.guessMath}
    />
  );
}
