import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, ArrowUpRight, ListChecks, Settings2, Sparkles, Square, Undo2, X } from 'lucide-react';
import { loadAiSettingsDeferred, isAiConfigured, resolveAiCredentials } from '../ai/aiSettings';
import { streamChatAgentic, type StreamHandle } from '../ai/aiClient';
import type { ChatMessage } from '../ai/provider';
import { workspaceApi, workspacePrompt, workspaceTools, type WorkspaceContext, type WorkspaceLocation, type WorkspacePlan, type WorkspaceReceipt } from '../ai/workspaceTools';
import { notifyLibraryChanged, releaseEditorLock, requestEditorFlush } from '../sync/events';
import { AiSettingsForm } from './AiSettingsForm';
import { MarkdownView } from './MarkdownView';
import './workspaceAssistant.css';

type Entry = { role: 'user' | 'assistant'; text: string };
type Props = {
  open: boolean;
  scope: string;
  context: WorkspaceContext;
  onClose: () => void;
  onOpenLocation: (location: WorkspaceLocation) => void;
};

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

async function withSavedEditor<T>(run: () => Promise<T>): Promise<T> {
  await requestEditorFlush();
  try { return await run(); }
  finally { await releaseEditorLock(); }
}

export function WorkspaceAssistant({ open, scope, context, onClose, onOpenLocation }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [message, setMessage] = useState('');
  const [share, setShare] = useState(false);
  const [running, setRunning] = useState(false);
  const [working, setWorking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [plan, setPlan] = useState<WorkspacePlan>();
  const [latest, setLatest] = useState<WorkspaceReceipt | null>(null);
  const modal = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const serial = useRef(0);
  const handle = useRef<StreamHandle>();
  const planId = useRef<string>();
  const receiptRevision = useRef(0);
  const historyStart = useRef(0);
  const connection = useRef('');

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    return () => { previous?.focus(); };
  }, [open]);

  useEffect(() => {
    if (open) (settingsOpen ? heading.current : textarea.current)?.focus();
  }, [open, settingsOpen]);

  useEffect(() => {
    if (!open || !scope) return;
    let active = true;
    const revision = receiptRevision.current;
    void workspaceApi.latest(scope).then(result => {
      if (active && revision === receiptRevision.current) setLatest(result);
    }).catch(error => { if (active) setMessage(messageOf(error)); });
    return () => { active = false; };
  }, [open, scope]);

  useEffect(() => () => {
    serial.current++;
    handle.current?.cancel();
    if (planId.current) void workspaceApi.discard(planId.current).catch(() => {});
  }, []);

  useEffect(() => {
    const view = scroller.current;
    if (view) view.scrollTop = view.scrollHeight;
  }, [entries, open, settingsOpen]);

  function stop() {
    serial.current++;
    handle.current?.cancel();
    handle.current = undefined;
    setRunning(false);
    setMessage('已停止生成');
  }

  function dismiss() {
    if (working || settingsBusy) return;
    if (running) stop();
    onClose();
  }

  function toggleShare(next: boolean) {
    setShare(next);
    historyStart.current = entries.length;
    if (entries.length) setMessage('已更新共享范围，下一条消息将开启新的上下文');
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (running || working || plan || !scope || !input.trim()) return;
    const settings = loadAiSettingsDeferred();
    if (!isAiConfigured(settings)) {
      setSettingsOpen(true);
      setMessage('请先配置 AI 模型');
      return;
    }
    const user: Entry = { role: 'user', text: input.trim() };
    const turn = ++serial.current;
    const active = () => serial.current === turn;
    const key = JSON.stringify([settings.kind, settings.baseUrl, settings.profileId]);
    if (connection.current && connection.current !== key) historyStart.current = entries.length;
    connection.current = key;
    setEntries([...entries, user, { role: 'assistant', text: '' }]);
    setInput('');
    setRunning(true);
    setMessage('正在准备对话');
    const revisions: Record<string, string | null> = {};
    const append = (delta: string) => setEntries(previous => {
      const last = previous.at(-1);
      return last?.role === 'assistant' ? [...previous.slice(0, -1), { ...last, text: last.text + delta }] : previous;
    });
    const finish = (status: string) => {
      if (!active()) return;
      handle.current = undefined;
      setRunning(false);
      setMessage(status);
    };
    try {
      await withSavedEditor(async () => {});
      if (!active()) return;
      const credentials = await resolveAiCredentials(settings);
      if (!active()) return;
      if (!isAiConfigured(credentials)) throw new Error('当前连接缺少密钥，请打开 AI 设置');
      const messages: ChatMessage[] = [
        { role: 'system', content: workspacePrompt(context, share) },
        ...entries.slice(historyStart.current).filter(row => row.text).map(row => ({ role: row.role, content: row.text })),
        { role: 'user', content: user.text },
      ];
      handle.current = streamChatAgentic(credentials, messages, {
        onDelta: delta => { if (active()) append(delta); },
        onDone: () => finish(''),
        onError: finish,
        onRoundStart: () => { if (active()) setMessage('正在生成回复'); },
        onRetry: notice => { if (active()) setMessage(`连接繁忙 · ${Math.ceil(notice.delayMs / 1000)} 秒后重试`); },
        onToolStart: name => { if (active()) setMessage(name === 'inspect_workspace' ? '正在查阅资料库' : '正在校验方案'); },
        tools: {
          definitions: workspaceTools(share),
          async execute(name, args) {
            try {
              if (!active()) return { status: 'cancelled' };
              if (name === 'inspect_workspace') {
                const result = await workspaceApi.read(args.query, scope, share);
                if (!active()) return { status: 'cancelled' };
                for (const [path, revision] of Object.entries(result.revisions)) {
                  if (Object.prototype.hasOwnProperty.call(revisions, path) && revisions[path] !== revision) {
                    return { status: 'error', message: '本轮读取后资料已有变化，请提示用户重新发送请求' };
                  }
                  revisions[path] = revision;
                }
                return result.data;
              }
              if (name !== 'propose_workspace_changes') return { status: 'error', message: '该工具不受支持' };
              if (planId.current) return { status: 'awaiting_confirmation', message: '本轮已有方案等待用户确认' };
              const draft = await workspaceApi.prepare(args, scope, revisions);
              if (!active()) {
                await workspaceApi.discard(draft.id);
                return { status: 'cancelled' };
              }
              planId.current = draft.id;
              setPlan(draft);
              return { status: 'awaiting_confirmation', operations: draft.changes.length };
            } catch (error) {
              return { status: 'error', message: messageOf(error) };
            }
          },
        },
      });
    } catch (error) {
      if (active()) { setInput(user.text); finish(messageOf(error)); }
    }
  }

  async function discard() {
    if (!plan || running || working) return;
    setWorking(true);
    try {
      await workspaceApi.discard(plan.id);
      planId.current = undefined;
      setPlan(undefined);
      setEntries(previous => [...previous, { role: 'assistant', text: '你已取消这批方案。' }]);
      setMessage('方案已取消');
    } catch (error) { setMessage(messageOf(error)); }
    finally { setWorking(false); }
  }

  async function apply() {
    if (!plan || running || working) return;
    setWorking(true);
    setMessage('正在应用变更');
    try {
      await withSavedEditor(async () => {
        const receipt = await workspaceApi.apply(plan.id, scope);
        receiptRevision.current++;
        setLatest(receipt);
        planId.current = undefined;
        setPlan(undefined);
        setEntries(previous => [...previous, {
          role: 'assistant',
          text: `你已应用本批 ${receipt.changeCount} 项变更。${receipt.destinations.map(item => ` ${item.name}`).join('')}`,
        }]);
        await notifyLibraryChanged().catch(() => setMessage('变更已保存，请重新打开相关白板刷新视图'));
      });
      setMessage(previous => previous === '正在应用变更' ? '' : previous);
    } catch (error) { setMessage(messageOf(error)); }
    finally { setWorking(false); }
  }

  async function undo() {
    if (!latest || running || working || plan) return;
    setWorking(true);
    setMessage('正在撤销');
    try {
      await withSavedEditor(async () => {
        await workspaceApi.undo(latest.id, scope);
        receiptRevision.current++;
        setLatest(null);
        setEntries(previous => [...previous, { role: 'assistant', text: '你已撤销上一批工作区变更。' }]);
        setMessage('已撤销上一批变更');
        await notifyLibraryChanged().catch(() => setMessage('变更已撤销，请重新打开相关白板刷新视图'));
      });
      setLatest(await workspaceApi.latest(scope));
    } catch (error) { setMessage(messageOf(error)); }
    finally { setWorking(false); }
  }

  const removals = plan?.changes.filter(change => change.removes).length ?? 0;

  if (!open) return null;
  return (
    <div className="workspace-ai-backdrop" onPointerDown={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
      <section ref={modal} className="workspace-assistant ai-root" role="dialog" aria-modal="true" aria-labelledby="workspace-ai-title" onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
        if (event.key !== 'Tab') return;
        const selector = 'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary';
        const fields = [...(modal.current?.querySelectorAll<HTMLElement>(selector) ?? [])].filter(item => item.getClientRects().length);
        const current = fields.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey ? current <= 0 : current < 0 || current === fields.length - 1) {
          event.preventDefault();
          (event.shiftKey ? fields.at(-1) : fields[0])?.focus();
        }
      }}>
        <header className="workspace-ai-head">
          <span className="workspace-ai-mark"><Sparkles size={19} aria-hidden="true" /></span>
          <div className="workspace-ai-heading">
            <h2 id="workspace-ai-title" ref={heading} tabIndex={-1}>AI 工作区</h2>
            <p>{[context.project?.path, context.board?.name].filter(Boolean).join(' / ') || '项目首页'}</p>
          </div>
          <button className="ai-icon-btn" type="button" aria-label="AI 模型设置" disabled={running || working || settingsBusy} onClick={() => setSettingsOpen(value => !value)}><Settings2 size={18} /></button>
          <button className="ai-icon-btn" type="button" aria-label="关闭 AI 工作区" disabled={working || settingsBusy} onClick={dismiss}><X size={20} /></button>
        </header>
        {settingsOpen ? <div className="workspace-ai-settings">
          <AiSettingsForm initial={loadAiSettingsDeferred()} boardTools={false} onSave={() => { setSettingsOpen(false); setMessage('已保存 AI 设置'); }}
            onCancel={() => setSettingsOpen(false)} onBusyChange={setSettingsBusy} />
        </div> : <div className={plan ? 'workspace-ai-body is-reviewing' : 'workspace-ai-body'}>
          <section className="workspace-ai-conversation" aria-label="工作区对话">
            <div ref={scroller} className="workspace-ai-messages">
              {!entries.length && <div className="workspace-ai-welcome">
                <h3>一起整理你的白板</h3>
                <p>可以指定上级项目、组织主题和分支、添加标签与子流程。</p>
                <button type="button" className="btn" onClick={() => {
                  setInput('在当前项目下新建一个子项目和一块学习白板，整理 [主题]。用主节点串起主要分支，给关键节点打标签，并用子流程记下操作步骤。');
                  textarea.current?.focus();
                }}>使用示例</button>
              </div>}
              {entries.map((row, index) => row.text && <div key={index} className={`workspace-ai-message is-${row.role}`}>
                {row.role === 'user' ? <div className="workspace-ai-user-text">{row.text}</div> : <MarkdownView value={row.text} />}
              </div>)}
            </div>
            {latest && <div className="workspace-ai-receipt">
              <span>已应用 {latest.changeCount} 项</span>
              <div className="workspace-ai-links">
                {latest.destinations.slice(0, 8).map(item => <button key={item.boardId ?? item.projectId} type="button" className="workspace-ai-link" disabled={working || running} onClick={() => {
                  onClose();
                  onOpenLocation(item);
                }}>{item.name}<ArrowUpRight size={13} /></button>)}
              </div>
              <button type="button" className="workspace-ai-link" disabled={working || running || !!plan} onClick={() => void undo()}><Undo2 size={15} /> 撤销上一批</button>
            </div>}
            <form className="workspace-ai-compose" onSubmit={event => void send(event)}>
              <label className="workspace-ai-share">
                <input type="checkbox" checked={share} disabled={working || running || !!plan} onChange={event => toggleShare(event.target.checked)} />
                允许读取现有白板的节点、连线和附件正文
              </label>
              <p className="workspace-ai-disclosure">发送时，资料库目录、标签和允许读取的内容可能发往所选模型。</p>
              <div className="workspace-ai-input-wrap">
                <textarea ref={textarea} aria-label="输入工作区请求" placeholder="告诉 AI 你想做什么…" value={input} onChange={event => setInput(event.target.value)}
                  onKeyDown={event => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }} />
                {running ? <button type="button" className="workspace-ai-send" aria-label="停止生成" onClick={stop}><Square size={17} /></button>
                  : <button type="submit" className="workspace-ai-send" disabled={!input.trim() || working || !!plan || !scope} aria-label="发送工作区请求"><ArrowUp size={20} /></button>}
              </div>
            </form>
          </section>
          {plan && <aside className="workspace-ai-plan" aria-label="待确认方案">
            <header><ListChecks size={18}/><h3>待确认方案</h3><span>{plan.changes.length} 项变更</span></header>
            {removals > 0 && <p className="workspace-ai-removals">含 {removals} 项移除。附件原件保留，可撤销本批变更。</p>}
            <ol className="workspace-ai-changes">
              {plan.changes.map((change, i) => <li key={i} className={change.removes ? 'is-removal' : undefined}>
                {change.before !== null || change.after !== null ? <details>
                  <summary><strong>{change.action}</strong><span>{change.location}</span></summary>
                  {change.before !== null && <div className="workspace-ai-diff"><small>原内容</small><pre>{change.before}</pre></div>}
                  {change.after !== null && <div className="workspace-ai-diff"><small>变更后</small><pre>{change.after}</pre></div>}
                </details> : <div className="workspace-ai-static"><strong>{change.action}</strong><span>{change.location}</span></div>}
              </li>)}
            </ol>
            <footer className="workspace-ai-actions">
              <button className="btn" type="button" disabled={running || working} onClick={() => void discard()}>取消方案</button>
              <button className="btn btn-primary" type="button" disabled={running || working} onClick={() => void apply()}>{removals ? '应用并移除' : '应用方案'}</button>
            </footer>
          </aside>}
        </div>}
        {message && <div className="workspace-ai-status" role="status">{message}</div>}
      </section>
    </div>
  );
}
