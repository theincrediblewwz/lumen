import { useEffect, useState } from 'react';
import { api } from './api';
import { AiChat } from './components/AiChat';
import { loadSettings, applySettings, subscribeSettings } from './settings';

/**
 * 独立 AI 对话窗口根组件（M5-1）。从 URL query 读取 project/board/name，
 * 主题跟随软件主体（同一 localStorage），窗口自绘标题栏。
 */
export function AiApp() {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get('project') ?? '';
  const boardId = params.get('board') ?? '';
  const boardName = params.get('name') ?? '白板';
  const [platform, setPlatform] = useState('');

  useEffect(() => {
    document.title = `AI 助手 · ${boardName} — 脉络 Lumen`;
  }, [boardName]);

  // 应用主题，并跨窗口跟随主窗口的实时切换（M6-1，AI 窗不启用原生玻璃）
  useEffect(() => {
    applySettings({ ...loadSettings(), glass: false });
    return subscribeSettings((s) => applySettings({ ...s, glass: false }));
  }, []);

  useEffect(() => {
    api.appInfo().then((i) => setPlatform(i.platform)).catch(() => {});
  }, []);

  return (
    <AiChat
      standalone
      platform={platform}
      projectId={projectId}
      boardId={boardId}
      boardName={boardName}
    />
  );
}

