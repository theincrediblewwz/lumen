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
import { streamChatAgentic, type StreamHandle } from '../ai/aiClient';
import type { ToolContext } from '../ai/tools';
import { buildBoardOutline, buildSystemPrompt } from '../ai/boardContext';
import { maskNodeRefs, unmaskNodeRefs } from '../ai/nodeRef';
import { jumpToNode } from '../ai/nodeJump';
import {
  loadBoardChats,
  saveBoardChats,
  deriveTitle,
  newId,
  type ChatsFile,
  type Conversation,
  type StoredMessage,
} from '../ai/chatStore';
import type { ChatMessage } from '../ai/provider';
import type { BoardNode } from '../api';

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
  /** 正在调用的工具名（agentic 查阅白板时显示） */
  tool?: string;
}

const TOOL_LABELS: Record<string, string> = {
  read_board_outline: '查看白板结构',
  list_nodes: '浏览节点列表',
  read_node_doc: '阅读节点文档',
  search_board: '检索白板内容',
};

/** 渲染 AI/用户消息的 Markdown（复用 M4 引擎 + KaTeX 排版）。
 *  节点引用 [[node:id]] 做两级保护 → 显示为节点标题胶囊，点击跳白板高亮。 */
function MessageBody({
  content,
  nodes,
  projectId,
  boardId,
}: {
  content: string;
  nodes: BoardNode[];
  projectId: string;
  boardId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleOf = useCallback(
    (id: string) => nodes.find((n) => n.id === id)?.title ?? null,
    [nodes],
  );
  const html = useMemo(() => {
    // 1) 渲染前把 [[node:id]] 换成 markdown 不会破坏的占位 token
    const { text, ids } = maskNodeRefs(content);
    // 2) 正常渲染 markdown + 公式占位
    // 关键：AI 输出的是规范 markdown（表格/加粗/需要公式时自己写 $…$），
    // 绝不能开 guessMath —— 那个启发式是给缺分界符的导入文档用的，
    // 会把表格分隔行 |---| 和加粗 ** 误当公式，把整段 markdown 搅烂。
    const rendered = renderMarkdown(text, undefined, { guessMath: false }).html;
    // 3) 渲染后把占位换成显示标题的可点击胶囊
    return unmaskNodeRefs(rendered, ids, titleOf);
  }, [content, titleOf]);

  useEffect(() => {
    if (ref.current) {
      const h = typesetMath(ref.current);
      return () => h.cancel();
    }
  }, [html]);

  // 事件委托：点击节点胶囊 → 跳转到白板并高亮
  const onClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('.node-ref');
      if (!target) return;
      const nodeId = target.getAttribute('data-node-id');
      if (!nodeId) return;
      e.preventDefault();
      jumpToNode({ projectId, boardId, nodeId });
    },
    [projectId, boardId],
  );

  return (
    <div
      ref={ref}
      className="ai-md markdown-body"
      onClick={onClick}
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
  const [showHistory, setShowHistory] = useState(false);
  // 对话历史（长期存白板 chats.json）：全部会话 + 当前会话 id
  const [chats, setChats] = useState<ChatsFile>({ version: 1, conversations: [] });
  const [convId, setConvId] = useState<string>(() => newId());
  const loadedRef = useRef(false);
  const handleRef = useRef<StreamHandle | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const configured = isAiConfigured(settings);
  const isMac = platform === 'macos';
  // 独立窗口在 Win/Linux 上自绘窗口控制（mac 用系统红绿灯，留白即可）
  const showWinControls = !!standalone && !isMac;

  // 拉取白板结构做上下文
  useEffect(() => {
    if (!projectId || !boardId) return;
    api
      .boardLoad(projectId, boardId)
      .then(setBoard)
      .catch(() => setBoard(null));
  }, [projectId, boardId]);

  // 加载本白板的历史对话（长期持久化，退出不丢）。
  // 若已有会话，默认续接最近一条；否则开新会话。
  useEffect(() => {
    if (!projectId || !boardId) return;
    let alive = true;
    loadBoardChats(projectId, boardId).then((loaded) => {
      if (!alive) return;
      setChats(loaded);
      const last = loaded.conversations[loaded.conversations.length - 1];
      if (last) {
        setConvId(last.id);
        setMessages(last.messages.map((m) => ({ role: m.role, content: m.content, error: m.error })));
      }
      loadedRef.current = true;
    });
    return () => {
      alive = false;
    };
  }, [projectId, boardId]);

  // 把当前会话的消息落盘（合并进 chats 后整体保存）。
  const persist = useCallback(
    (uiMsgs: UiMessage[]) => {
      if (!loadedRef.current) return;
      const stored: StoredMessage[] = uiMsgs
        .filter((m) => !m.streaming && m.content)
        .map((m) => ({
          role: m.role,
          content: m.content,
          error: m.error,
          at: new Date().toISOString(),
        }));
      if (stored.length === 0) return;
      setChats((prev) => {
        const now = new Date().toISOString();
        const idx = prev.conversations.findIndex((c) => c.id === convId);
        const conv: Conversation = {
          id: convId,
          title: deriveTitle(stored),
          createdAt: idx >= 0 ? prev.conversations[idx].createdAt : now,
          updatedAt: now,
          messages: stored,
        };
        const conversations = prev.conversations.slice();
        if (idx >= 0) conversations[idx] = conv;
        else conversations.push(conv);
        const next = { version: 1 as const, conversations };
        void saveBoardChats(projectId, boardId, next);
        return next;
      });
    },
    [convId, projectId, boardId],
  );

  // 新建对话：保存当前 → 清空开新会话
  const newConversation = useCallback(() => {
    setConvId(newId());
    setMessages([]);
    setShowHistory(false);
    setShowSettings(false);
  }, []);

  // 切到某条历史会话
  const openConversation = useCallback(
    (id: string) => {
      const conv = chats.conversations.find((c) => c.id === id);
      if (!conv) return;
      setConvId(id);
      setMessages(conv.messages.map((m) => ({ role: m.role, content: m.content, error: m.error })));
      setShowHistory(false);
      setShowSettings(false);
    },
    [chats],
  );

  // 窗口控制（独立窗口）
  const winCtl = useCallback(async (action: 'minimize' | 'maximize' | 'close') => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const w = getCurrentWindow();
      if (action === 'minimize') await w.minimize();
      else if (action === 'maximize') await w.toggleMaximize();
      else await w.close();
    } catch {
      /* 非 Tauri 环境忽略 */
    }
  }, []);

  // 默认进对话窗口，不自动弹设置；未配置时在输入区给出提示引导点 ⚙

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

    // 白板共享开启且已加载白板时，注入工具上下文让 AI 主动查阅（M5-3）
    const toolCtx: ToolContext | undefined =
      settings.shareBoard && board
        ? { board, readDoc: (p) => api.docRead(projectId, boardId, p) }
        : undefined;

    handleRef.current = streamChatAgentic(
      settings,
      history,
      {
        onDelta: (d) =>
          patchLast((m) => ({ ...m, content: m.content + d, tool: undefined })),
        onToolStart: (name) =>
          patchLast((m) => ({ ...m, tool: TOOL_LABELS[name] ?? name })),
        onDone: () => {
          patchLast((m) => ({ ...m, streaming: false, tool: undefined }));
          setBusy(false);
          handleRef.current = null;
          setMessages((cur) => {
            persist(cur);
            return cur;
          });
        },
        onError: (msg) => {
          patchLast((m) => ({
            ...m,
            streaming: false,
            tool: undefined,
            error: true,
            content: m.content || `⚠️ ${msg}`,
          }));
          setBusy(false);
          handleRef.current = null;
          setMessages((cur) => {
            persist(cur);
            return cur;
          });
        },
      },
      toolCtx,
    );
  }, [input, busy, configured, messages, settings, systemPrompt, board, projectId, boardId, persist]);

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
    <div
      className={`ai-root${standalone ? ' is-standalone' : ''}${isMac && standalone ? ' is-mac' : ''}`}
      data-platform={platform}
    >
      <header
        className={`ai-titlebar${standalone ? ' is-standalone-bar' : ''}`}
        {...(standalone ? { 'data-tauri-drag-region': true } : {})}
      >
        <span className="ai-title" {...(standalone ? { 'data-tauri-drag-region': true } : {})}>
          AI 助手 · {boardName}
        </span>
        <div className="ai-titlebar-actions">
          <button
            type="button"
            className="ai-icon-btn"
            title="新对话"
            aria-label="新对话"
            onClick={newConversation}
          >
            ＋
          </button>
          <button
            type="button"
            className={`ai-icon-btn${showHistory ? ' is-active' : ''}`}
            title={showHistory ? '返回对话' : '历史对话'}
            aria-label="历史对话"
            onClick={() => {
              setShowHistory((v) => !v);
              setShowSettings(false);
            }}
          >
            🕘
          </button>
          <button
            type="button"
            className="ai-icon-btn"
            title={showSettings ? '返回对话' : '设置'}
            aria-label="设置"
            onClick={() => {
              setShowSettings((v) => !v);
              setShowHistory(false);
            }}
          >
            ⚙
          </button>
          {/* 浮层模式：用回调关闭；独立窗口(非 mac)：自绘窗口三键 */}
          {onClose && !standalone && (
            <button type="button" className="ai-icon-btn" title="关闭" aria-label="关闭" onClick={onClose}>
              ✕
            </button>
          )}
          {showWinControls && (
            <div className="ai-wincontrols">
              <button
                type="button"
                className="win-btn"
                title="最小化"
                aria-label="最小化"
                onClick={() => winCtl('minimize')}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M1 5h8" stroke="currentColor" strokeWidth="1.1" />
                </svg>
              </button>
              <button
                type="button"
                className="win-btn"
                title="最大化"
                aria-label="最大化"
                onClick={() => winCtl('maximize')}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="1.3" y="1.3" width="7.4" height="7.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
                </svg>
              </button>
              <button
                type="button"
                className="win-btn win-close"
                title="关闭"
                aria-label="关闭"
                onClick={() => winCtl('close')}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </header>

      {showSettings ? (
        <AiSettingsForm initial={settings} onSave={saveAndClose} onCancel={() => setShowSettings(false)} />
      ) : showHistory ? (
        <div className="ai-history">
          <div className="ai-history-head">
            <h3>历史对话</h3>
            <button type="button" className="ai-btn-secondary" onClick={newConversation}>
              ＋ 新对话
            </button>
          </div>
          {chats.conversations.length === 0 ? (
            <p className="ai-hint">还没有历史对话。发起对话后会自动保存在本白板文件夹里，退出也不会丢失。</p>
          ) : (
            <ul className="ai-history-list">
              {chats.conversations
                .slice()
                .reverse()
                .map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`ai-history-item${c.id === convId ? ' is-current' : ''}`}
                      onClick={() => openConversation(c.id)}
                    >
                      <span className="ai-history-title">{c.title}</span>
                      <span className="ai-history-meta">
                        {c.messages.length} 条 · {new Date(c.updatedAt).toLocaleString()}
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
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
                {m.tool && (
                  <div className="ai-tool-status">
                    <span className="ai-tool-spinner" /> 正在{m.tool}…
                  </div>
                )}
                {m.content ? (
                  <MessageBody
                    content={m.content}
                    nodes={board?.nodes ?? []}
                    projectId={projectId}
                    boardId={boardId}
                  />
                ) : m.tool ? null : (
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
