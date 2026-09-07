import { useEffect, useState } from 'react';
import { api } from './api';
import { AiChat } from './components/AiChat';
import { loadSettings, applySettings } from './settings';

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
    applySettings({ ...loadSettings(), glass: false });
    document.title = `AI 助手 · ${boardName} — 脉络 Lumen`;
  }, [boardName]);

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
