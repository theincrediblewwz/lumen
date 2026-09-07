import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type BoardFile } from '../api';
import { renderMarkdown } from '../reader/engine';
import { typesetMath } from '../reader/reader';
import {
  loadAiSettings,
  saveAiSettings,
  isAiConfigured,
  type AiSettings,
} from '../ai/aiSettings';
import { streamChat, type StreamHandle } from '../ai/aiClient';
import { buildBoardOutline, buildSystemPrompt } from '../ai/boardContext';
import type { ChatMessage } from '../ai/provider';

interface Props {
  projectId: string;
  boardId: string;
  boardName: string;
  /** 独立窗口模式（自绘标题栏留白），或应用内浮层模式 */
  standalone?: boolean;
  platform?: string;
  onClose?: () => void;
}

interface UiMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 正在流式生成中 */
  streaming?: boolean;
  error?: boolean;
}

/** 渲染 AI/用户消息的 Markdown（复用 M4 引擎 + KaTeX 排版）。 */
function MessageBody({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(content, undefined, { guessMath: true }).html, [content]);
  useEffect(() => {
    if (ref.current) {
      const h = typesetMath(ref.current);
      return () => h.cancel();
    }
  }, [html]);
  return (
    <div
      ref={ref}
      className="ai-md markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function AiChat({ projectId, boardId, boardName, standalone, platform, onClose }: Props) {
  const [settings, setSettings] = useState<AiSettings>(() => loadAiSettings());
  const [board, setBoard] = useState<BoardFile | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const handleRef = useRef<StreamHandle | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const configured = isAiConfigured(settings);

  // 拉取白板结构做上下文
  useEffect(() => {
    if (!projectId || !boardId) return;
    api
      .boardLoad(projectId, boardId)
      .then(setBoard)
      .catch(() => setBoard(null));
  }, [projectId, boardId]);

  // 打开即根据配置决定是否弹设置
  useEffect(() => {
    if (!configured) setShowSettings(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const systemPrompt = useMemo(() => {
    if (!board) return buildSystemPrompt('', settings.shareBoard);
    return buildSystemPrompt(buildBoardOutline(board), settings.shareBoard);
  }, [board, settings.shareBoard]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || busy || !configured) return;
    setInput('');

    const history: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages
        .filter((m) => !m.error)
        .map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
      { role: 'user', content: text },
    ];

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text },
      { role: 'assistant', content: '', streaming: true },
    ]);
    setBusy(true);

    const patchLast = (fn: (m: UiMessage) => UiMessage) =>
      setMessages((prev) => {
        const copy = prev.slice();
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].role === 'assistant') {
            copy[i] = fn(copy[i]);
            break;
          }
        }
        return copy;
      });

    handleRef.current = streamChat(settings, history, {
      onDelta: (d) => patchLast((m) => ({ ...m, content: m.content + d })),
      onDone: () => {
        patchLast((m) => ({ ...m, streaming: false }));
        setBusy(false);
        handleRef.current = null;
      },
      onError: (msg) => {
        patchLast((m) => ({
          ...m,
          streaming: false,
          error: true,
          content: m.content || `⚠️ ${msg}`,
        }));
        setBusy(false);
        handleRef.current = null;
      },
    });
  }, [input, busy, configured, messages, settings, systemPrompt]);

  const stop = useCallback(() => {
    handleRef.current?.cancel();
    handleRef.current = null;
    setMessages((prev) => {
      const copy = prev.slice();
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === 'assistant') {
          copy[i] = { ...copy[i], streaming: false };
          break;
        }
      }
      return copy;
    });
    setBusy(false);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const saveAndClose = (s: AiSettings) => {
    setSettings(s);
    saveAiSettings(s);
    setShowSettings(false);
  };

  return (
    <div className={`ai-root${standalone ? ' is-standalone' : ''}`} data-platform={platform}>
      <header className="ai-titlebar" data-tauri-drag-region>
        <span className="ai-title">AI 助手 · {boardName}</span>
        <div className="ai-titlebar-actions">
          <button
            type="button"
            className="ai-icon-btn"
            title="设置"
            onClick={() => setShowSettings((v) => !v)}
          >
            ⚙
          </button>
          {onClose && (
            <button type="button" className="ai-icon-btn" title="关闭" onClick={onClose}>
              ✕
            </button>
          )}
        </div>
      </header>

      {showSettings ? (
        <AiSettingsForm initial={settings} onSave={saveAndClose} onCancel={() => setShowSettings(false)} />
      ) : (
        <>
          <div className="ai-messages" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="ai-empty">
                <p className="ai-empty-title">问问关于「{boardName}」的问题</p>
                <p className="ai-empty-hint">
                  {settings.shareBoard
                    ? 'AI 已读取本白板的节点与连线结构，可以问「研究脉络是什么」「帮我梳理这些问题的关系」。'
                    : '（白板共享已关闭，当前为普通对话）'}
                </p>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`ai-msg ai-msg-${m.role}${m.error ? ' is-error' : ''}`}>
                <div className="ai-msg-role">{m.role === 'user' ? '你' : 'AI'}</div>
                {m.content ? (
                  <MessageBody content={m.content} />
                ) : (
                  <div className="ai-typing"><span></span><span></span><span></span></div>
                )}
              </div>
            ))}
          </div>

          <div className="ai-composer">
            {!configured && (
              <div className="ai-warn">
                尚未配置 AI，请先点右上角 ⚙ 填写接口地址与密钥。
              </div>
            )}
            <div className="ai-composer-row">
              <textarea
                className="ai-input"
                placeholder={configured ? '输入问题，Enter 发送，Shift+Enter 换行' : '请先在设置中配置 AI'}
                value={input}
                disabled={!configured}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                rows={2}
              />
              {busy ? (
                <button type="button" className="ai-send is-stop" onClick={stop}>
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  className="ai-send"
                  onClick={send}
                  disabled={!configured || !input.trim()}
                >
                  发送
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function AiSettingsForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: AiSettings;
  onSave: (s: AiSettings) => void;
  onCancel: () => void;
}) {
  const [s, setS] = useState<AiSettings>(initial);
  const patch = (p: Partial<AiSettings>) => setS((x) => ({ ...x, ...p }));
  return (
    <div className="ai-settings">
      <h3>AI 设置</h3>
      <label className="ai-field">
        <span>接口地址（OpenAI 兼容）</span>
        <input
          type="text"
          value={s.baseUrl}
          placeholder="https://api.openai.com/v1"
          onChange={(e) => patch({ baseUrl: e.target.value })}
        />
      </label>
      <label className="ai-field">
        <span>API Key</span>
        <input
          type="password"
          value={s.apiKey}
          placeholder="sk-..."
          onChange={(e) => patch({ apiKey: e.target.value })}
        />
      </label>
      <label className="ai-field">
        <span>模型</span>
        <input
          type="text"
          value={s.model}
          placeholder="gpt-4o-mini"
          onChange={(e) => patch({ model: e.target.value })}
        />
      </label>
      <label className="ai-field">
        <span>温度 {s.temperature.toFixed(1)}</span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.1}
          value={s.temperature}
          onChange={(e) => patch({ temperature: Number(e.target.value) })}
        />
      </label>
      <label className="ai-check">
        <input
          type="checkbox"
          checked={s.shareBoard}
          onChange={(e) => patch({ shareBoard: e.target.checked })}
        />
        <span>允许 AI 读取本白板内容（关闭则仅普通对话）</span>
      </label>
      <p className="ai-hint">
        可接 OpenAI、DeepSeek、Kimi 或任意 OpenAI 兼容网关；密钥仅存于本机。
      </p>
      <div className="ai-settings-actions">
        <button type="button" className="ai-btn-secondary" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="ai-btn-primary"
          onClick={() => onSave(s)}
          disabled={!s.baseUrl.trim() || !s.model.trim()}
        >
          保存
        </button>
      </div>
    </div>
  );
}
