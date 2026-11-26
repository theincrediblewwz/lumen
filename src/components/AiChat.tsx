import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, BOARD_LABELS_CHANGED, type BoardFile } from '../api';
import { renderMarkdown } from '../reader/engine';
import { typesetMath } from '../reader/reader';
import {
  loadAiSettingsDeferred,
  resolveAiCredentials,
  isAiConfigured,
  savedAiSettingsAvailable,
  aiToolLimits,
  type AiSettings,
} from '../ai/aiSettings';
import { ArrowUp, History, MoreHorizontal, SlidersHorizontal, Square, SquarePen, X } from 'lucide-react';
import { AiSettingsForm } from './AiSettingsForm';
import { loadCatalogue } from '../ai/catalogStore';
import { streamChatAgentic, streamChat, type AiRunLimit, type StreamHandle } from '../ai/aiClient';
import { TOOL_DEFS, WRITE_TOOL, type ToolContext } from '../ai/tools';
import { buildBoardContext, buildSystemPrompt, focusedNodeContext } from '../ai/boardContext';
import { fitWithinBudget } from '../ai/budget';
import { maskNodeRefs, unmaskNodeRefs } from '../ai/nodeRef';
import { jumpToNode } from '../ai/nodeJump';
import {
  loadBoardChats,
  loadBoardChatsSnapshot,
  saveConversation,
  deriveTitle,
  newId,
  type ChatsFile,
  type Conversation,
  type StoredMessage,
} from '../ai/chatStore';
import { requestInputTokens, type ChatMessage } from '../ai/provider';
import { invoke } from '@tauri-apps/api/core';
import { captureKey, captureTurnsForSelection, completedCaptureTurns, conversationMarkdown } from '../ai/chatCapture';
import { openReaderWindow } from '../reader/windowManager';
import { requestEditorFlush, notifyLibraryChanged, releaseEditorLock } from '../sync/events';
import { loadKnowledge, openKnowledge } from '../knowledge/store';
import { resolveKnowledgeReferences, knowledgeReferenceText, knowledgeReferenceLinks, type KnowledgeReference } from '../knowledge/core';
import { messageTokens } from '../ai/budget';
import { loadWritePolicy,loadFlushedBoard,commitBoardOperations,type OperationResult } from '../ai/boardOperations';
import { prepareBoardBatch } from '../ai/boardArrangement';
import { prepareMemory, memoryData, loadMemory, validMemory, type ChatMemory } from '../ai/chatMemory';
import { CONVERSATION_TOOLS } from '../ai/conversationTools';
import type { SessionStatus } from './AiChatHost';
import { useGrowingTextarea } from './useGrowingTextarea';
import { claimGeneration, type GenerationLease } from '../ai/generationLease';
import {ContextMenu,type ContextMenuState} from './ContextMenu';
import {createPortal} from 'react-dom';
import {deleteConversation,HISTORY_CHANGED,type DeletedConversation,type HistoryChange} from '../ai/historyActions';
import {removeMemory} from '../ai/chatMemory';
import { ChatResponseTiming, type ChatTimingReport } from './ChatResponseTiming';
export { AiChat } from './AiChatHost';

export interface Props {
  projectId: string;
  boardId: string;
  boardName: string;
  nodeId?: string;
  conversationId?: string;
  messageIds?: string[];
  /** 独立窗口模式（自绘标题栏留白），或应用内浮层模式 */
  standalone?: boolean;
  platform?: string;
  onClose?: () => void;
  registerLeaveGuard?: (guard: (() => boolean) | null) => void;
  visible?:boolean;
  retentionKey?:string;
  onRetentionChange?:(key:string,retained:boolean)=>void;
}
interface PaneProps extends Props { freshId?:string;initialHistory?:boolean;onConversationDeleted:(item:DeletedConversation)=>void; paneKey:string; onNavigate:(id?:string,messages?:string[])=>void; onSessionStatus:(key:string,status:SessionStatus)=>void; sessionSignals:Record<string,SessionStatus> }

interface UiMessage extends StoredMessage {
  id: string;
  /** 正在流式生成中 */
  streaming?: boolean;
  /** 正在调用的工具名（agentic 查阅白板时显示） */
  tool?: string;
}

const storedMessage = ({ id, at, role, content, error, pause }: UiMessage): StoredMessage => ({ id, at, role, content, error, pause });

const TOOL_LABELS: Record<string, string> = {
  read_board_outline: '查看白板结构',
  list_nodes: '浏览节点列表',
  read_node_doc: '阅读节点文档',
  search_board: '检索白板内容',
  search_conversation: '检索对话历史',
  read_conversation: '阅读对话原文',
  apply_board_operations: '整理白板并保存版本',
};

/** 渲染 AI/用户消息的 Markdown（复用 M4 引擎 + KaTeX 排版）。
 *  节点引用 [[node:id]] 做两级保护 → 显示为节点标题胶囊，点击跳白板高亮。 */
const MessageBody=memo(function MessageBody({
  content,
  nodeTitles,
  projectId,
  boardId,
}: {
  content: string;
  nodeTitles?: ReadonlyMap<string, string>;
  projectId: string;
  boardId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const rendered = useMemo(() => {
    // 1) 渲染前把 [[node:id]] 换成 markdown 不会破坏的占位 token
    const { text, ids } = maskNodeRefs(content);
    // 2) 正常渲染 markdown + 公式占位
    // 关键：AI 输出的是规范 markdown（表格/加粗/需要公式时自己写 $…$），
    // 绝不能开 guessMath —— 那个启发式是给缺分界符的导入文档用的，
    // 会把表格分隔行 |---| 和加粗 ** 误当公式，把整段 markdown 搅烂。
    return { html: renderMarkdown(text, undefined, { guessMath: false }).html, ids };
  }, [content]);
  const html = useMemo(() => unmaskNodeRefs(rendered.html, rendered.ids, id => nodeTitles ? nodeTitles.get(id) ?? null : undefined), [rendered, nodeTitles]);

  useEffect(() => {
    if (ref.current) {
      const h = typesetMath(ref.current);
      return () => h.cancel();
    }
  }, [html]);

  // 事件委托：点击节点胶囊 → 跳转到白板并高亮
  const onClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="learnstuff-knowledge://"]');
      const reference = anchor?.getAttribute('href')?.match(/^learnstuff-knowledge:\/\/([a-zA-Z0-9_-]{1,128})\/([a-zA-Z0-9_-]{1,128})$/);
      if (reference) { e.preventDefault(); void openKnowledge(reference[1], reference[2]); return; }
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
});

export function ChatPane({ projectId, boardId, boardName, nodeId: requestedNode, conversationId: requestedConversation, messageIds: requestedMessages, standalone, platform, onClose, visible=true, freshId, paneKey, onNavigate, onSessionStatus, sessionSignals,initialHistory,onConversationDeleted }: PaneProps) {
  const [settings, setSettings] = useState<AiSettings>(() => loadAiSettingsDeferred());
  const [settingsReady, setSettingsReady] = useState(false);
  const [board, setBoard] = useState<BoardFile | null>(null);
  const boardReadEpoch = useRef(0);
  const nodeTitles = useMemo(() => board ? new Map(board.nodes.map(node => [node.id, node.title])) : undefined, [board]);
  const [messages, renderMessages] = useState<UiMessage[]>([]);
  const [visibleMessages,setVisibleMessages]=useState(80);
  const messagesRef=useRef<UiMessage[]>([]);
  const messagePaint = useRef<ReturnType<typeof setTimeout>>();
  const nextMessagePaintAt = useRef(0);
  // Event callbacks always see the newest transcript, even before React paints.
  // Persistence must run outside React state updaters (which may be replayed).
  const setMessages=useCallback((next:UiMessage[]|((current:UiMessage[])=>UiMessage[]), streaming = false)=>{
    messagesRef.current=typeof next==='function'?next(messagesRef.current):next;
    const paint = () => {
      messagePaint.current = undefined;
      nextMessagePaintAt.current = streaming ? performance.now() + 50 : 0;
      renderMessages(messagesRef.current);
    };
    const wait = nextMessagePaintAt.current - performance.now();
    if (streaming && wait > 0) {
      if (messagePaint.current === undefined) messagePaint.current = setTimeout(paint, wait);
      return;
    }
    clearTimeout(messagePaint.current);
    paint();
  },[]);
  useEffect(() => () => clearTimeout(messagePaint.current), []);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const generation=useRef(0);
  const loadEpoch=useRef(0);
  const requestActive=useRef(false);
  const saveQueue=useRef<Promise<unknown>>(Promise.resolve());
  const pendingSaves=useRef(0);
  const unsaved=useRef(false);
  const [savingTranscript,setSavingTranscript]=useState(false);
  const [transcriptError,setTranscriptError]=useState(false);
  const [progress,setProgress]=useState('');
  const [timing, setTiming] = useState<ChatTimingReport>();
  const [memory,setMemory]=useState<ChatMemory>();
  const [loadError,setLoadError]=useState('');
  const [writingBoard,setWritingBoard]=useState(false);
  const writeLock=useRef(false);
  const pendingWrite=useRef<Promise<void>>(Promise.resolve());
  const leaseRef=useRef<GenerationLease>();
  const releaseLease=async(lease=leaseRef.current)=>{if(lease){try{await lease.release();if(leaseRef.current===lease){leaseRef.current=undefined;unsaved.current=false;if(mounted.current)setTranscriptError(false);}}catch(e){unsaved.current=true;if(mounted.current){setTranscriptError(true);setCaptureStatus(`对话已保存，释放运行状态失败，请重试保存：${String(e)}`);}}}};
  const [knowledgePreview, setKnowledgePreview] = useState<{ text: string; refs: KnowledgeReference[]; revision: string }>();
  const preparingKnowledge = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const resolvingCredentials = useRef(false);
  const [unlocking, setUnlocking] = useState(false);
  const mounted = useRef(true);
  const [selectedMessages, setSelectedMessages] = useState<Set<string>>(new Set());
  const [sourceNodeId,setSourceNodeId]=useState(requestedNode);
  const [captureParent, setCaptureParent] = useState(requestedNode ?? '');
  const [documentTarget,setDocumentTarget]=useState(requestedNode ?? '');
  const [captureStatus, setCaptureStatus] = useState('');
  const [savingCapture, setSavingCapture] = useState(false);
  const [savedCapture, setSavedCapture] = useState<{path:string;title:string}>();
  const captureLock = useRef(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(!!initialHistory);
  const [historyMenu,setHistoryMenu]=useState<ContextMenuState|null>(null);
  const [deleteCandidate,setDeleteCandidate]=useState<{conversation:Conversation;receipt:string}>();
  const [historyBusy,setHistoryBusy]=useState(false),[deletedConversation,setDeletedConversation]=useState(false);
    const deletedState=useRef(false);
  const [deleteError,setDeleteError]=useState('');
  const inputValue=useRef(input);inputValue.current=input;
  const inputRef=useRef<HTMLTextAreaElement>(null);
  useGrowingTextarea(inputRef,input,visible&&!showSettings&&!showHistory);
  // 对话历史（长期存白板 chats.json）：全部会话 + 当前会话 id
  const [chats, setChats] = useState<ChatsFile>({ version: 1, conversations: [] });
  const [convId, setConvId] = useState<string>(() => freshId??newId());
  const activeConversation = useRef(convId);
  activeConversation.current = convId;
  const [highlightedMessages, setHighlightedMessages] = useState<string[]>([]);
  const pendingMessageJump = useRef<string[] | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout>>();
  const loadedRef = useRef(false);
  const conversationScope=useRef<string>();
  const handleRef = useRef<StreamHandle | null>(null);
  const currentReplyId=useRef<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const configured = isAiConfigured(settings);
  const captureTurns = useMemo(() => completedCaptureTurns(messages), [messages]);
  const capturableIds = new Set(captureTurns.flat().map(message => message.id));
  const selectedTurnCount = captureTurns.filter(turn => turn.some(message => selectedMessages.has(message.id))).length;
  const interactionLocked = busy || savingCapture || unlocking || preparing || writingBoard || savingTranscript || transcriptError || historyBusy;
  const activity = useRef(false); activity.current = interactionLocked || requestActive.current || pendingSaves.current>0 || unsaved.current;
  useLayoutEffect(()=>{onSessionStatus(paneKey,{conversationId:convId,title:deriveTitle(messages),working:busy||preparing||unlocking||writingBoard||savingTranscript||savingCapture,retained:interactionLocked||!!input||!!knowledgePreview||showSettings,progress,failed:transcriptError,initialized:loadedRef.current||!!loadError,navigationLocked:savingCapture||historyBusy});},[paneKey,convId,messages,busy,preparing,unlocking,writingBoard,savingTranscript,savingCapture,interactionLocked,input,knowledgePreview,showSettings,progress,transcriptError,loadError,onSessionStatus,chats,settingsReady]);
  const historyRows=chats.conversations.filter(c=>requestedNode?c.sourceNodeId===requestedNode:!c.sourceNodeId);
  const requestedMessageKey = requestedMessages?.join(',') ?? '';
  const isMac = platform === 'macos';
  // 独立窗口在 Win/Linux 上自绘窗口控制（mac 用系统红绿灯，留白即可）
  const showWinControls = !!standalone && Boolean(platform) && !isMac;

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape'||!visible||document.querySelector('.action-confirm[aria-modal="true"]')) return;
      if(deleteCandidate){if(!historyBusy)setDeleteCandidate(undefined);}
      else if (knowledgePreview) setKnowledgePreview(undefined);
      else if (showSettings) setShowSettings(false);
      else if (showHistory) setShowHistory(false);
      else if (onClose) onClose();
      else return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [knowledgePreview, showSettings, showHistory, onClose, visible,deleteCandidate,historyBusy]);

  // Opening a chat/settings window must never trigger Keychain authorization.
  useEffect(() => {
    let alive = true;
    mounted.current = true;
    loadCatalogue().catch(() => {}).finally(() => { if (alive) setSettingsReady(true); });
    return () => {
      alive = false;
      mounted.current = false;
    };
  }, []);

  const adoptBoard = useCallback((snapshot: BoardFile) => {
    setBoard(current => snapshot._disk_revision && snapshot._disk_revision === current?._disk_revision ? current : snapshot);
  }, []);
  const readChatBoard = useCallback(async (read = () => api.boardSnapshot(projectId, boardId, conversationScope.current)) => {
    const epoch = ++boardReadEpoch.current;
    const snapshot = await read();
    if (mounted.current && epoch === boardReadEpoch.current) adoptBoard(snapshot);
    return snapshot;
  }, [projectId, boardId, adoptBoard]);

  // 独立聊天窗口读取白板快照，写入基线仍由主编辑器维护。
  useEffect(() => {
    if (!projectId || !boardId || !visible) return;
    let disposed = false;
    const stops: (() => void)[] = [];
    const refresh = () => { if (!disposed) void readChatBoard().catch(() => {}); };
    window.addEventListener('focus', refresh);
    if ('__TAURI_INTERNALS__' in window) void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const retain = (stop: () => void) => { if (disposed) stop(); else stops.push(stop); };
      await Promise.all([
        listen('lumen://library-changed', refresh).then(retain),
        listen<{ projectId: string; boardId: string }>(BOARD_LABELS_CHANGED, ({ payload }) => {
          if (payload.projectId === projectId && payload.boardId === boardId) refresh();
        }).then(retain),
      ]);
      refresh();
    }).catch(refresh);
    else refresh();
    return () => {
      disposed = true;
      boardReadEpoch.current++;
      window.removeEventListener('focus', refresh);
      stops.forEach(stop => stop());
    };
  }, [projectId, boardId, visible, readChatBoard]);

  // 加载本白板的历史对话（长期持久化，退出不丢）。
  // 若已有会话，默认续接最近一条；否则开新会话。
  useEffect(() => {
    if (!projectId || !boardId) return;
    let alive = true;
    const epoch=++loadEpoch.current;
    loadBoardChatsSnapshot(projectId, boardId).then(({chats:loaded,scope}) => {
      if (!alive || epoch!==loadEpoch.current || activity.current || captureLock.current) return;
      setChats(loaded);
      if('__TAURI_INTERNALS__' in window&&!scope)throw Error('无法确认原始对话资料目录，未开启写入。');
      conversationScope.current=scope;
      const last = freshId?undefined:requestedConversation ? loaded.conversations.find(c=>c.id===requestedConversation) : loaded.conversations.filter(c=>requestedNode ? c.sourceNodeId===requestedNode : !c.sourceNodeId).slice(-1)[0];
      if (last) {
        activeConversation.current = last.id;
        pendingMessageJump.current = requestedMessageKey.split(',').filter(Boolean);
        setSourceNodeId(last.sourceNodeId ?? requestedNode); setCaptureParent(last.sourceNodeId ?? requestedNode ?? ""); setDocumentTarget(last.sourceNodeId ?? requestedNode ?? "");
        setConvId(last.id);
        setMessages(last.messages.map((m, i) => ({ ...m, id: m.id ?? `${last.id}_m_${i}` })));
      } else if (requestedConversation) setCaptureStatus('原对话不存在或已删除归档，已保存的笔记仍可阅读。');
      loadedRef.current = true;setLoadError('');setMemory(undefined);
      if(last){const cached=loadMemory(last.id);void validMemory(cached,last.id,last.messages.filter(m=>!m.error&&m.content)).then(valid=>{if(alive&&activeConversation.current===last.id&&valid)setMemory(cached);});}
    }).catch(error=>{if(alive){setLoadError(String(error));setCaptureStatus(String(error));}});
    return () => {
      alive = false;
    };
  }, [projectId, boardId, requestedConversation, requestedNode, freshId]);
  useEffect(()=>{if(requestedMessageKey)pendingMessageJump.current=requestedMessageKey.split(',').filter(Boolean);},[requestedMessageKey]);

  // Serialize receipt/final saves and await the native merge before unlocking.
  const persist = useCallback(
    async (uiMsgs: UiMessage[]):Promise<boolean> => {
      if (!loadedRef.current) return true;
      const stored = uiMsgs.filter(m => m.content || m.pause).map(storedMessage);
      if (stored.length === 0) return true;
      const now = new Date().toISOString();
      const conv: Conversation = {
          id: convId,
          title: deriveTitle(stored),
          createdAt: uiMsgs[0]?.at ?? now,
          updatedAt: now,
          messages: stored,
          sourceNodeId,
      };
      pendingSaves.current++;activity.current=true;setSavingTranscript(true);
      const token=leaseRef.current?.token;
      const saving=saveQueue.current.catch(()=>{}).then(()=>saveConversation(projectId,boardId,conv,conversationScope.current,token));
      saveQueue.current=saving;
      try{
        await saving;
        if(!mounted.current)return true;
        unsaved.current=false;setTranscriptError(false);
        setChats((prev) => {
        const idx = prev.conversations.findIndex((c) => c.id === conv.id);
        const conversations = prev.conversations.slice();
        if (idx >= 0) conversations[idx] = conv;
        else conversations.push(conv);
        const next = { version: 1 as const, conversations };
        return next;
        });
        return true;
      }catch(error){
        unsaved.current=true;
        if(mounted.current){setTranscriptError(true);setCaptureStatus(`回答仍保留在此窗口，保存未完成：${String(error)}。可重试保存，或先导出当前对话 Markdown。`);}
        return false;
      }finally{
        pendingSaves.current--;
        if(mounted.current)setSavingTranscript(pendingSaves.current>0);
      }
    },
    [convId, projectId, boardId, sourceNodeId],
  );

  const newConversation = useCallback(() => { onNavigate(); }, [onNavigate]);
  useEffect(()=>()=>{
    const lease=leaseRef.current;if(!lease)return;
    generation.current++;handleRef.current?.cancel();handleRef.current=null;
    void pendingWrite.current.then(()=>persist(messagesRef.current)).then(ok=>{if(ok)return releaseLease(lease);});
  },[persist]);
  const openConversation = useCallback((id:string) => { setShowHistory(false);onNavigate(id); }, [onNavigate]);
  const toggleHistory=()=>{
    setShowHistory(v=>!v);setShowSettings(false);
    void loadBoardChats(projectId,boardId,conversationScope.current).then(loaded=>{if(mounted.current)setChats(loaded);}).catch(e=>setCaptureStatus(String(e)));
  };
  useEffect(()=>{
    let alive=true,historyEpoch=0;const stops:Array<()=>void>=[];
    const changed=(event:HistoryChange)=>{
      if(event.projectId!==projectId||event.boardId!==boardId||event.scope!==conversationScope.current)return;
      const own=++historyEpoch;if(event.deleted)removeMemory(event.conversationId);
      void loadBoardChats(projectId,boardId,conversationScope.current).then(loaded=>{if(!alive||own!==historyEpoch)return;setChats(loaded);const restored=loaded.conversations.find(c=>c.id===activeConversation.current);if(deletedState.current&&restored){deletedState.current=false;setDeletedConversation(false);setMessages(restored.messages.map((m,i)=>({...m,id:m.id??`${restored.id}_m_${i}`})));setCaptureStatus('对话已恢复，当前草稿仍保留。');}}).catch(e=>{if(alive)setCaptureStatus(String(e));});
      if(event.deleted&&event.conversationId===activeConversation.current){
        if(!activity.current&&!inputValue.current)onConversationDeleted({conversationId:event.conversationId,scope:event.scope,receipt:''});
        else{deletedState.current=true;setDeletedConversation(true);setCaptureStatus('原对话已删除归档，当前草稿仍保留；请复制到新对话。已保存的笔记仍可阅读。');}
      }
    };
    const local=(e:Event)=>changed((e as CustomEvent<HistoryChange>).detail);window.addEventListener(HISTORY_CHANGED,local);
    if('__TAURI_INTERNALS__'in window)void import('@tauri-apps/api/event').then(async({listen})=>{const stop=await listen<HistoryChange>('lumen://chat-history-changed',e=>changed(e.payload));if(alive)stops.push(stop);else stop();}).catch(e=>{if(alive)setCaptureStatus(String(e));});
    return()=>{alive=false;window.removeEventListener(HISTORY_CHANGED,local);stops.forEach(stop=>stop());};
  },[projectId,boardId,onConversationDeleted]);
  const historyContext=(event:React.MouseEvent,conversation:Conversation)=>{
    event.preventDefault();event.stopPropagation();
    const protectedConversation=!!sessionSignals[conversation.id]?.retained||conversation.id===convId&&(activity.current||!!inputValue.current);
    setHistoryMenu({x:event.clientX,y:event.clientY,items:[{type:'item',label:'删除历史对话',danger:true,disabled:protectedConversation||historyBusy,onClick:()=>{setDeleteError('');setDeleteCandidate({conversation,receipt:crypto.randomUUID()});}},...(protectedConversation?[{type:'info' as const,text:'请先完成生成、保存或处理草稿'}]:[])]});
  };
  const confirmDelete=async()=>{
    if(!deleteCandidate||historyBusy||!conversationScope.current)return;
    activity.current=true;setHistoryBusy(true);
    try{const result=await deleteConversation(projectId,boardId,deleteCandidate.conversation,conversationScope.current,deleteCandidate.receipt);setDeleteCandidate(undefined);onConversationDeleted(result);setChats(await loadBoardChats(projectId,boardId,conversationScope.current));}
    catch(error){setDeleteError(String(error));}finally{if(mounted.current)setHistoryBusy(false);}
  };

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

  // Source links position the original messages instead of immediately scrolling
  // back to the end of a long conversation.
  useEffect(() => {
    if(!visible)return;
    const el = scrollRef.current;
    const requested = pendingMessageJump.current;
    if (el && requested?.length) {
      const index=messages.findIndex(message=>requested.includes(message.id));
      if(index>=0&&index<messages.length-visibleMessages){setVisibleMessages(messages.length-index+8);return;}
      const target = [...el.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => requested.includes(node.dataset.messageId ?? ''));
      if (target) {
        target.scrollIntoView({ block: 'center' }); setHighlightedMessages(requested); pendingMessageJump.current = null;
        clearTimeout(highlightTimer.current); highlightTimer.current = setTimeout(() => setHighlightedMessages([]), 3500);
        return;
      }
    }
    if (highlightedMessages.length) return;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, showSettings, showHistory, visible, requestedMessageKey, visibleMessages]);
  useEffect(() => () => clearTimeout(highlightTimer.current), []);

  const send = useCallback(async (checked?: { text: string; refs: KnowledgeReference[]; revision: string }) => {
    const text = checked?.text ?? input.trim();
    if (!text || activity.current || deletedState.current || !configured || resolvingCredentials.current || captureLock.current || !loadedRef.current) return;
    if (!savedAiSettingsAvailable(settings)) {
      setSettings(loadAiSettingsDeferred());
      setCaptureStatus('这套 AI 配置已删除，请确认连接后再发送。');
      return;
    }
    if (preparingKnowledge.current) return;
    preparingKnowledge.current = true; requestActive.current=true; activity.current = true; setPreparing(true);setProgress('正在读取白板与参考资料');
    const startedAt = performance.now();
    let phaseStarted = startedAt;
    let firstAnswer = false;
    let roundWriting = false;
    setTiming({ startedAt, local: {}, rounds: [], memoryRequests: 0, toolCount: 0, toolMs: 0 });
    const updateTiming = (update: (report: ChatTimingReport) => ChatTimingReport) => {
      setTiming(report => report?.startedAt === startedAt && report.finishedAt === undefined ? update(report) : report);
    };
    const markPhase = (phase: keyof ChatTimingReport['local']) => {
      const now = performance.now();
      const elapsed = now - phaseStarted;
      phaseStarted = now;
      updateTiming(report => ({ ...report, local: { ...report.local, [phase]: (report.local[phase] ?? 0) + elapsed } }));
    };
    const finishTiming = (outcome: ChatTimingReport['outcome']) => {
      const finishedAt = performance.now();
      updateTiming(report => ({ ...report, finishedAt, outcome }));
    };
    loadEpoch.current++;
    let streamStarted=false;
    let claimed:GenerationLease|undefined;
    const requestConversation = convId;
    const requestGeneration=++generation.current;
    currentReplyId.current=undefined;
    const currentRequest = () => mounted.current && generation.current===requestGeneration && activeConversation.current === requestConversation && !captureLock.current;
    const validateRequest = async () => {
      if (!savedAiSettingsAvailable(settings)) throw new Error('这套 AI 配置已删除，已停止后续请求。');
      await claimed!.validate();
    };
    try {
    const permission=await loadWritePolicy().catch(()=>null);
    if(!permission?.scope||permission.scope!==conversationScope.current)throw Error('资料目录已变化，请返回原资料目录后再续聊；原对话未改动。');
    const scope = permission.scope;
    let refs: KnowledgeReference[] = [];
    let requestBoard: BoardFile;
    try {
      const [freshBoard, snapshot] = await Promise.all([
        readChatBoard(permission.policy.enabled && settings.shareBoard ? () => loadFlushedBoard(projectId, boardId, scope) : undefined),
        settings.shareBoard ? loadKnowledge() : undefined,
      ]);
      requestBoard = freshBoard;
      if (!currentRequest()) return;
      refs = snapshot ? resolveKnowledgeReferences(snapshot.library, boardId, text, { nodeId: sourceNodeId, sourceBound: requestBoard._sync_content_policy?.mode === 'summary', allowOutside: requestBoard._sync_content_policy?.allowOutsideKnowledge }) : [];
      if (checked && (snapshot?.revision !== checked.revision || JSON.stringify(refs) !== JSON.stringify(checked.refs))) throw new Error('知识或白板在预览后改变，请重新预览');
      if (!checked && snapshot && refs.length) { setKnowledgePreview({ text, refs, revision: snapshot.revision }); return; }
    } catch (e) { setCaptureStatus(String(e)); return; }
    finally { markPhase('context'); }
    setKnowledgePreview(undefined);
    const knowledgeMessage: ChatMessage = { role: 'user', content: knowledgeReferenceText(refs) };
    const knowledgeTokens = refs.length ? messageTokens(knowledgeMessage) : 0;
    if (knowledgeTokens > settings.contextBudget - 1000) { setCaptureStatus('个人参考超过当前预算，请减少指定条目或增大上下文预算'); return; }

    const focus = requestBoard?.nodes.find(n=>n.id===sourceNodeId);
    if(sourceNodeId && settings.shareBoard && !focus){setCaptureStatus("来源节点已不存在，请从白板重新选择节点。");return;}
    const nodeContext=requestBoard&&settings.shareBoard?focusedNodeContext(requestBoard,sourceNodeId):'';
    if(!currentRequest())return;
    const canWrite=!!permission?.policy.enabled && settings.shareBoard;
    const { toolRounds, boardWriteBatches } = aiToolLimits(settings);
    const writeInstructions = canWrite ? [
      '用户已在本机授权白板整理。当前白板的新增、移动、配色和自动排版都通过 apply_board_operations 写入。若用户要求直接整理，先查目标再实际调用工具。',
      '先理清入口、层级和阅读顺序。用有向箭头表达父子关系，可用同一分支的统一色标，在 Markdown 中用 =={#RRGGBB}关键词== 突出少量重点。',
      '位置和色标用 update_node_presentation，includeDescendants=true 会让整棵分支一起平移或配色。不要猜坐标，先通过 list_nodes 查当前位置。',
      '创建完节点和连线后，若需排版，单独提交 arrange_nodes。默认用 auto，应用会测量卡片并组合横展与纵排。要把多个分支从上到下各放一行，选择 branches，按顺序传 rootIds 和 stack=true。需要保留分支内部相对位置时，用 update_node_presentation 整棵平移。仅整理用户指定范围，新增分支可用回执 ID 单独排版。子流程步骤顺序保留。',
      `单次发送允许 ${toolRounds} 轮工具请求和 ${boardWriteBatches} 批白板写入。按工具规定分批，续做先核对最新白板。只报告有成功回执的操作。`,
    ].join('\n') : '当前未开启 AI 修改白板，只能读取与建议。可说明设置中的「AI 整理白板」入口。';
    const systemMessage: ChatMessage = { role: 'system', content: buildSystemPrompt(settings.shareBoard ? buildBoardContext(requestBoard, settings.contextBudget) : '', settings.shareBoard) + nodeContext + '\n\n' + writeInstructions };
    const question: ChatMessage = { role: 'user', content: text };
    const definitions=[...(settings.shareBoard&&requestBoard?TOOL_DEFS:[]),...CONVERSATION_TOOLS,...(canWrite?[WRITE_TOOL]:[])];
    const toolTokens=requestInputTokens([],definitions);
    const pinnedTokens = requestInputTokens([systemMessage, question], definitions) + knowledgeTokens;
    if(pinnedTokens+32>settings.contextBudget){setCaptureStatus('问题、白板和个人参考超过当前预算，请减少内容或增大上下文预算');return;}
    if (!currentRequest()) return;
    markPhase('context');
    setProgress('正在确认对话写入状态');
    claimed=await claimGeneration(projectId,boardId,convId,messagesRef.current.filter(m=>!m.streaming),conversationScope.current);
    markPhase('lease');
    leaseRef.current=claimed;
    if(!currentRequest()){await releaseLease(claimed);return;}
    let connection: AiSettings;
    resolvingCredentials.current = true; setUnlocking(true);setProgress('正在读取已保存连接');
    try {
      connection = await resolveAiCredentials(settings);
      if (!currentRequest()) return;
      if (!isAiConfigured(connection)) throw new Error('未找到可用密钥');
      setCaptureStatus('');
    } catch { if (mounted.current) setCaptureStatus('未能读取已保存密钥。原连接和密钥已保留；再次发送可重试授权，也可在设置中填写密钥。'); return; }
    finally { markPhase('credentials'); resolvingCredentials.current = false; if (mounted.current) setUnlocking(false); }
    setInput('');
    pendingMessageJump.current = null; setHighlightedMessages([]); setSavedCapture(undefined);

    const replyId=newId();
    currentReplyId.current=replyId;
    setMessages((prev) => [
      ...prev,
      { id: newId(), at: new Date().toISOString(), role: 'user', content: text },
      { id: replyId, at: new Date().toISOString(), role: 'assistant', content: '', streaming: true },
    ]);
    setBusy(true);
    streamStarted=true;

    const patchLast = (fn: (m: UiMessage) => UiMessage, streaming = false) =>
      setMessages((prev) => {
        const copy = prev.slice();
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].id === replyId) {
            copy[i] = fn(copy[i]);
            break;
          }
        }
        return copy;
      }, streaming);

    // Persist the user's original question before any extra summary/provider work.
    setProgress('正在保存原始提问');
    const questionSaved = await persist(messagesRef.current);
    markPhase('question');
    if(!questionSaved){setMessages(prev=>prev.filter(m=>m.id!==replyId));streamStarted=false;setBusy(false);return;}
    if(!currentRequest())return;
    const originalMessages=messagesRef.current.filter(m=>(m.content||m.pause)&&!m.streaming).map(storedMessage);
    const priorMessages=originalMessages.slice(0,-1);
    const memoryBudget=settings.contextBudget-toolTokens-knowledgeTokens-messageTokens(systemMessage)-messageTokens({role:'user',content:text})-160;
    const prepared=connection.memoryMode==='off'?{memory:undefined,remaining:priorMessages,notice:''}:await prepareMemory({id:convId,messages:priorMessages,budget:memoryBudget,model:connection.model,current:currentRequest,progress:setProgress,generate:prompt=>new Promise<string>((resolve,reject)=>{
      updateTiming(report => ({ ...report, memoryRequests: report.memoryRequests + 1 }));
      let output='';const compactSettings={...connection,contextBudget:Math.min(settings.contextBudget,12000),maxTokens:Math.min(connection.maxTokens??2400,2400)};
      handleRef.current=streamChat(compactSettings,prompt,{sessionId:convId,beforeRequest:validateRequest,onDelta:d=>{output+=d;},onDone:()=>resolve(output),onError:reject});
    })});
    if(!currentRequest())return;
    setMemory(prepared.memory);if(prepared.notice)setCaptureStatus(prepared.notice);
    const remembered:ChatMessage|undefined=prepared.memory?{role:'user',content:memoryData(prepared.memory)}:undefined;
    const useMemory=remembered&&messageTokens(remembered)<Math.max(0,memoryBudget*.65);
    const rawHistory:ChatMessage[]=[systemMessage,...(useMemory?prepared.remaining:priorMessages).filter(m=>!m.error).map(m=>({role:m.role,content:m.pause?`${m.content}\n\n[此回答未完成] ${m.pause}`:m.content})),question];
    const memoryTokens = useMemory ? messageTokens(remembered!) : 0;
    const toolReserve = Math.min(12_000, Math.floor(settings.contextBudget * .2), Math.max(0, settings.contextBudget - pinnedTokens - memoryTokens - 64));
    const history=fitWithinBudget(rawHistory,settings.contextBudget-knowledgeTokens-toolTokens-memoryTokens-toolReserve-64,0).messages;
    if(useMemory)history.splice(1,0,remembered!);
    if(refs.length)history.splice(history.length-1,0,knowledgeMessage);
    markPhase('memory');
    if(requestInputTokens(history,definitions)>settings.contextBudget){patchLast(m=>({...m,streaming:false,error:true,content:'上下文仍超出预算，本次未发送回答请求；问题原文已保存，请增大预算后重试。'}));if(await persist(messagesRef.current))await releaseLease(claimed);finishTiming('notSent');requestActive.current=false;setBusy(false);setProgress('');return;}

    // 白板共享开启且已加载白板时，注入工具上下文让 AI 主动查阅（M5-3）
    const toolCtx: ToolContext = {board:requestBoard,shareBoard:settings.shareBoard,allowBoard:()=>loadAiSettingsDeferred().shareBoard,conversationMessages:originalMessages,readDoc:p=>api.docRead(projectId,boardId,p,conversationScope.current)};
    let savedBatches = 0;
    if(canWrite){
      const receipts=new Map<string,string>();
      toolCtx.applyOperations=async(args,callId)=>{
        const requestId=receipts.get(callId)??`op_${crypto.randomUUID().replace(/-/g,'')}`;receipts.set(callId,requestId);
        writeLock.current=true;setWritingBoard(true);
        let writeDone!:()=>void;pendingWrite.current=new Promise<void>(resolve=>{writeDone=resolve;});
        try{
          const baseline = toolCtx.board;
          const signal = toolCtx.signal!;
          const batch = await prepareBoardBatch(args, baseline, document.body, scope, signal, (done, count) => {
            if (currentRequest()) setProgress(`正在测量白板节点 · ${done}/${count}`);
          });
          const result=await commitBoardOperations(projectId,boardId,batch,requestId,permission,baseline,()=>signal.aborted||!currentRequest()||!loadAiSettingsDeferred().shareBoard);
          if (!result.reused) savedBatches++;
          toolCtx.board=result.board;
          boardReadEpoch.current++;
          adoptBoard(toolCtx.board);
          const links=Object.values(result.nodes??{}).map(id=>`[[node:${id}]]`).join('、');
          const receipt=`${result.summary}${links?` ${links}`:''}${result.warning?` ${result.warning}`:''} 可在白板历史中恢复。`;
          patchLast(m=>({...m,content:`${m.content}\n\n${receipt}\n\n`}));if(await persist(messagesRef.current))setCaptureStatus(`${result.summary} 可在白板历史中恢复。${result.warning??""}`);
          return JSON.stringify({summary:result.summary,nodes:result.nodes,backup:result.backup});
        }catch(e){setCaptureStatus(`本批未写入：${String(e)}；此前成功批次仍保留，可在白板历史恢复。`);return JSON.stringify({error:String(e),applied:false});}finally{writeLock.current=false;writeDone();if(mounted.current)setWritingBoard(false);}
      };
    }

    const finishReply=async(error?:string, limit?: AiRunLimit)=>{
      if(generation.current!==requestGeneration)return;
      const reason = limit?.message ?? (savedBatches > 0 ? error : undefined);
      const pause = reason ? `${savedBatches ? `已保存 ${savedBatches} 批白板操作。` : ''}${reason}`.slice(0, 1200) : undefined;
      const failed = !!error && !pause;
      patchLast(m=>({...m,content:failed?(m.content||`⚠️ ${error}`):m.content+knowledgeReferenceLinks(refs),streaming:false,tool:undefined,error:failed,pause}));
      if (pause || error) setCaptureStatus(pause ? '' : error!);
      setProgress('正在保存对话');
      phaseStarted = performance.now();
      handleRef.current=null;
      currentReplyId.current=undefined;
      const saved = await persist(messagesRef.current);
      if(saved)await releaseLease(claimed);
      markPhase('save');
      finishTiming(failed || !saved || leaseRef.current === claimed ? 'failed' : pause ? 'paused' : 'completed');
      requestActive.current=false;
      if(mounted.current){setBusy(false);setProgress('');}
    };
    handleRef.current = streamChatAgentic(
      connection,
      history,
      {
        sessionId: convId,
        beforeRequest: async () => {
          if (currentRequest()) setProgress('正在检查连接与资料权限');
          await validateRequest();
          const nowPolicy=await loadWritePolicy();if(nowPolicy.scope!==conversationScope.current)throw Error('资料目录已变化，已停止原会话后续请求；原内容仍保留。');
          if(!settings.shareBoard)return;
          if(!loadAiSettingsDeferred().shareBoard)throw Error('白板共享已关闭，已停止原会话后续请求。');
          const [latestKnowledge, latestBoard] = await Promise.all([loadKnowledge(), readChatBoard()]);
          const current = resolveKnowledgeReferences(latestKnowledge.library, boardId, text, { nodeId: sourceNodeId, sourceBound: latestBoard._sync_content_policy?.mode === 'summary', allowOutside: latestBoard._sync_content_policy?.allowOutsideKnowledge });
          if (JSON.stringify(current) !== JSON.stringify(refs)) throw new Error('知识内容或引用权限已变化，已停止后续 AI 请求，请重新预览');
        },
        onRoundStart:()=>{if(currentRequest()){roundWriting=false;setProgress('正在等待模型响应');patchLast(m=>({...m,tool:undefined}));}},
        onRetry:notice=>{if(currentRequest())setProgress(`${notice.reason}，${Math.ceil(notice.delayMs/1000)} 秒后自动重试（${notice.attempt}/${notice.maxRetries}）`);},
        onReasoning:()=>{if(currentRequest()&&!roundWriting)setProgress('模型正在思考');},
        onRoundTiming: round => {
          if (!currentRequest()) return;
          updateTiming(report => {
            const rounds = report.rounds.slice();
            rounds[round.round - 1] = round;
            return { ...report, rounds };
          });
          if (round.streamMs === undefined && round.firstTextMs === undefined && round.firstReasoningMs === undefined) {
            if (round.firstDeliveryMs !== undefined) setProgress('已收到流数据，等待模型正文或工具指令');
            else if (round.headersMs !== undefined) setProgress('服务已响应，等待首个流数据块');
          }
        },
        onToolTiming: ms => updateTiming(report => ({ ...report, toolCount: report.toolCount + 1, toolMs: report.toolMs + ms })),
        onToolEnd:()=>{if(currentRequest()){setProgress('正在整理工具结果');patchLast(m=>({...m,tool:undefined}));}},
        onDelta: (d) => {
          if(!currentRequest())return;
          if (!firstAnswer && d.trim()) {
            firstAnswer = true;
            const firstAnswerMs = performance.now() - startedAt;
            updateTiming(report => ({ ...report, firstAnswerMs }));
          }
          if (!roundWriting && d.trim()) {
            roundWriting = true;
            setProgress('正在生成回答');
          }
          patchLast(m => ({ ...m, content: m.content + d, tool: undefined }), true);
        },
        onToolStart: (name) => {
          if(!currentRequest())return;
          setProgress(`正在${TOOL_LABELS[name] ?? '执行工具'}`);patchLast((m) => ({ ...m, tool: TOOL_LABELS[name] ?? name }));
        },
        onDone: () => {void finishReply();},
        onLimit: notice => {void finishReply(undefined, notice);},
        onError: (msg) => {void finishReply(msg);},
      },
      toolCtx,
    );
    } catch(e){if(mounted.current&&generation.current===requestGeneration){setCaptureStatus(String(e));if(streamStarted){setMessages(prev=>prev.map(m=>m.streaming?{...m,streaming:false,error:true,content:m.content||`回答未完成：${String(e)}`}:m));if(await persist(messagesRef.current))await releaseLease(claimed);finishTiming('failed');setBusy(false);requestActive.current=false;setProgress('');}}} finally { if(!streamStarted&&!unsaved.current)await releaseLease(claimed);preparingKnowledge.current = false;if(!streamStarted){requestActive.current=false;if(mounted.current&&generation.current===requestGeneration)finishTiming(unsaved.current?'failed':'notSent');} if (mounted.current) {setPreparing(false);if(!streamStarted)setProgress('');} }
  }, [input, configured, settings, readChatBoard, projectId, boardId, persist, convId, sourceNodeId, adoptBoard]);

  const stop = useCallback(async () => {
    if(pendingSaves.current)return;
    const saveStarted = performance.now();
    const reportStopped = (saved: boolean) => {
      const finishedAt = performance.now();
      setTiming(report => report && report.finishedAt === undefined ? { ...report, finishedAt, outcome: 'stopped', local: saved ? { ...report.local, save: finishedAt - saveStarted } : report.local } : report);
    };
    const lease=leaseRef.current;
    generation.current++;
    handleRef.current?.cancel();
    handleRef.current = null;
    await pendingWrite.current;
    const reply=currentReplyId.current;currentReplyId.current=undefined;
    if(!reply&&!unsaved.current){await releaseLease(lease);requestActive.current=false;if(mounted.current){reportStopped(false);setBusy(false);setProgress('');}return;}
    setMessages((prev) => {
      const copy = prev.slice();
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].id===reply&&copy[i].streaming) {
          copy[i] = { ...copy[i], content:copy[i].content+'\n\n[回答已中止，以上可能不完整]', streaming: false, tool:undefined };
          break;
        }
      }
      return copy;
    });
    setProgress('正在保存已生成内容');
    if(await persist(messagesRef.current))await releaseLease(lease);
    requestActive.current=false;
    if(mounted.current){reportStopped(true);setBusy(false);setProgress('');}
  }, [persist]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const saveAndClose = (s: AiSettings) => {
    if(settings.shareBoard&&!s.shareBoard&&requestActive.current)void stop();
    setSettings(loadAiSettingsDeferred());
    setShowSettings(false);
  };

  const exportTranscript=async()=>{
    try{
      const original=messagesRef.current.filter(m=>m.content||m.pause);
      if(!original.length)return;
      const {save}=await import('@tauri-apps/plugin-dialog');
      const destination=await save({title:'导出当前对话 Markdown',defaultPath:'Lumen-对话.md',filters:[{name:'Markdown',extensions:['md']}]});
      if(!destination)return;
      const markdown=`# ${deriveTitle(original)}\n\n${original.map(m=>`## ${m.role==='user'?'提问':'回答'}${m.streaming?' · 尚未完成':m.error?' · 未完成或失败':m.pause?' · 已暂停':''}\n\n${m.content}${m.pause?`\n\n> ${m.pause.replace(/\n/g, ' ')}`:''}`).join('\n\n---\n\n')}\n`;
      await invoke('chat_transcript_export',{markdown,destination});setCaptureStatus('当前对话已导出，原始记录未改动。');
    }catch(error){setCaptureStatus(`导出未完成：${String(error)}`);}
  };

  const saveSelection = async (ids: Set<string>,targetNode?:string) => {
    if (captureLock.current || activity.current || preparingKnowledge.current || deletedState.current) return;
    captureLock.current = true; setSavingCapture(true); setCaptureStatus(''); setSavedCapture(undefined);
    let editorLocked=false;
    try {
      const selected = captureTurnsForSelection(messages, ids);
      if (!selected.length) throw new Error('请在回答完成后选择问答');
      if((await loadWritePolicy()).scope!==conversationScope.current)throw Error('资料目录已变化，原对话未写入新目录。');
      await requestEditorFlush();
      editorLocked=true;
      const title = deriveTitle(selected[0].role === 'user' ? selected : [{ role:'user', content:selected[0].content.replace(/^#+\s*/,'').slice(0,60), at:selected[0].at }]);
      const key = await captureKey(convId, selected);
      const markdown = conversationMarkdown(title, convId, selected, captureParent || undefined,{projectId,boardId});
      const now=new Date().toISOString();
      const conversation={id:convId,title:deriveTitle(messages),sourceNodeId,createdAt:chats.conversations.find(c=>c.id===convId)?.createdAt??messages[0]?.at??now,updatedAt:now,messages:messages.filter(m=>!m.streaming&&(m.content||m.pause)).map(storedMessage)};
      let attached:OperationResult|undefined;
      if(targetNode){const current=await api.boardLoad(projectId,boardId);attached=await invoke<OperationResult>('chat_document_attach',{projectId,boardId,expectedRevision:current._disk_revision,expectedScope:conversationScope.current,requestId:`doc_${key}_${targetNode.slice(-40)}`,nodeId:targetNode,title,markdown,conversation});}
      const next = attached?.board ?? await invoke<BoardFile>('chat_capture', { projectId, boardId, key, title, markdown, conversationId:convId, conversation, messageIds:selected.map(m=>m.id), parentId:captureParent || null,expectedScope:conversationScope.current });
      if (!mounted.current || activeConversation.current !== convId) return;
      const captured = targetNode?next.nodes.find(node=>node.id===targetNode):next.nodes.find(node => node.docs.some(doc => doc.path === `docs/chat_${key}.md`));
      if (captured) setSavedCapture({path:targetNode?attached!.documents![0]:`docs/chat_${key}.md`,title});
      boardReadEpoch.current++;
      adoptBoard(next);
      const savedChats=await loadBoardChats(projectId,boardId,conversationScope.current);
      if (!mounted.current || activeConversation.current !== convId) return;
      const savedConversation=savedChats.conversations.find(c=>c.id===convId);
      if(savedConversation){setChats(savedChats);setMessages(savedConversation.messages.map((m,i)=>({...m,id:m.id??`${convId}_m_${i}`})));}
      setSelectedMessages(new Set());
      setCaptureStatus(targetNode?'已存为节点文档，原有文档已保留。':board?.nodes.some(node=>node.id===captured?.id)?'这组问答已保存，已保留原节点。':`已保存 ${selected.filter(m=>m.role==='assistant').length} 条回答及对应问题。`);
      await notifyLibraryChanged();
    } catch (error) { setCaptureStatus(String(error)); }
    finally { if(editorLocked)await releaseEditorLock().catch(()=>{}); captureLock.current = false; if(mounted.current)setSavingCapture(false); }
  };

  useEffect(()=>{
    if(!('__TAURI_INTERNALS__' in window))return;
    let disposed=false;let stop:(()=>void)|undefined;
    void import('@tauri-apps/api/event').then(async({listen})=>{
      const off=await listen('lumen://library-changed',()=>{
        if(activity.current||captureLock.current)return;
        const epoch=++loadEpoch.current;
        void loadBoardChats(projectId,boardId,conversationScope.current).then(loaded=>{
          if(disposed||epoch!==loadEpoch.current||activity.current)return;
          setChats(loaded);const found=loaded.conversations.find(c=>c.id===convId);
          if(found)setMessages(found.messages.map((m,i)=>({...m,id:m.id??`${convId}_m_${i}`})));
        }).catch(e=>setCaptureStatus(String(e)));
      });if(disposed)off();else stop=off;
    });return()=>{disposed=true;stop?.();};
  },[projectId,boardId,convId]);

  return (
    <div
      className={`ai-root${standalone ? ' is-standalone' : ''}${isMac && standalone ? ' is-mac' : ''}${standalone && !platform ? ' is-platform-pending' : ''}`}
      data-platform={platform}
    >
      {historyMenu&&<ContextMenu state={historyMenu} onClose={()=>setHistoryMenu(null)}/>}
      {deleteCandidate&&createPortal(<div className="settings-overlay" onMouseDown={()=>{if(!historyBusy)setDeleteCandidate(undefined);}}><div className="settings-card knowledge-confirm" role="alertdialog" aria-modal="true" aria-label="删除历史对话" onMouseDown={e=>e.stopPropagation()}><p>删除“{deleteCandidate.conversation.title}”？已保存的节点、文档和知识会保留。</p>{deleteError&&<p role="alert">{deleteError}</p>}<div className="knowledge-actions"><button className="btn" disabled={historyBusy} onClick={()=>setDeleteCandidate(undefined)}>取消</button><button className="btn" disabled={historyBusy} onClick={()=>void confirmDelete()}>删除对话</button></div></div></div>,document.body)}
      <header
        className={`ai-titlebar${standalone ? ' is-standalone-bar' : ''}`}
        {...(standalone ? { 'data-tauri-drag-region': true } : {})}
      >
        <span className="ai-title" {...(standalone ? { 'data-tauri-drag-region': true } : {})}>
          <span>AI 对话</span><span className="ai-board-name">{boardName}</span>
        </span>
        <div className="ai-titlebar-actions">
          <button
            type="button"
            className="ai-icon-btn"
            title="新对话"
            aria-label="新对话"
            disabled={savingCapture}
            onClick={newConversation}
          >
            <SquarePen size={18} strokeWidth={1.7} aria-hidden="true"/>
          </button>
          <button
            type="button"
            className={`ai-icon-btn${showHistory ? ' is-active' : ''}`}
            title={showHistory ? '返回对话' : '历史对话'}
            aria-label="历史对话"
            disabled={savingCapture}
            onClick={toggleHistory}
          >
            <History size={18} strokeWidth={1.7} aria-hidden="true"/>
          </button>
          <button
            type="button"
            className="ai-icon-btn"
            title={showSettings ? '返回对话' : '设置'}
            aria-label="设置"
            aria-pressed={showSettings}
            disabled={savingCapture || !settingsReady}
            onClick={() => {
              setShowSettings((v) => !v);
              setShowHistory(false);
            }}
          >
            <SlidersHorizontal size={18} strokeWidth={1.7} aria-hidden="true"/>
          </button>
          {/* 浮层模式：用回调关闭；独立窗口(非 mac)：自绘窗口三键 */}
          {onClose && !standalone && (
            <button type="button" className="ai-icon-btn" title="关闭" aria-label="关闭" onClick={onClose}>
              <X size={18} strokeWidth={1.7} aria-hidden="true"/>
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
        <AiSettingsForm initial={savedAiSettingsAvailable(settings) ? settings : loadAiSettingsDeferred()} onSave={saveAndClose}
          onDelete={next => { if (requestActive.current && !savedAiSettingsAvailable(settings)) void stop(); setSettings(next); }}
          onCancel={() => setShowSettings(false)} />
      ) : showHistory ? (
        <div className="ai-history">
          <div className="ai-history-head">
            <h3>历史对话</h3>
            <button type="button" className="ai-btn-secondary" onClick={newConversation}>
              ＋ 新对话
            </button>
          </div>
          {historyRows.length === 0 ? (
            <p className="ai-hint">还没有历史对话。发起对话后会自动保存在本白板文件夹里，退出也不会丢失。</p>
          ) : (
            <ul className="ai-history-list">
              {historyRows
                .slice()
                .reverse()
                .map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`ai-history-item${c.id === convId ? ' is-current' : ''}`}
                      onContextMenu={e=>historyContext(e,c)}
                      onKeyDown={e=>{if(e.key==='ContextMenu'||e.shiftKey&&e.key==='F10'){e.preventDefault();const r=e.currentTarget.getBoundingClientRect();historyContext({preventDefault:()=>{},stopPropagation:()=>{},clientX:r.left+20,clientY:r.top+20} as React.MouseEvent,c);}}}
                      onClick={() => openConversation(c.id)}
                    >
                      <span className="ai-history-title">{c.title}</span>
                      <span className="ai-history-meta">
                        {sessionSignals[c.id]?.working ? <><span className="ai-tool-spinner"/> {sessionSignals[c.id].progress||"运行中"}</> : sessionSignals[c.id]?.failed ? "保存未完成" : `${c.messages.length} 条 · ${new Date(c.updatedAt).toLocaleString()}`}
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          {sourceNodeId && <p className="ai-scope">基于节点 · {board?.nodes.find(n=>n.id===sourceNodeId)?.title ?? "来源节点"}{!settings.shareBoard ? " · 尚未分享节点内容" : ""}</p>}
          <div className="ai-messages" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="ai-empty">
                <p className="ai-empty-title">从一个问题开始</p>
                <p className="ai-empty-hint">
                  {settings.shareBoard
                    ? '围绕白板，继续你的思考。'
                    : '白板内容不会随问题发送。'}
                </p>
              </div>
            )}
            {messages.length>visibleMessages&&<button className="ai-btn-secondary" onClick={()=>setVisibleMessages(n=>n+40)}>读取更早记录 · 还有 {messages.length-visibleMessages} 条</button>}
            {messages.slice(-visibleMessages).map((m) => (
              <div key={m.id} data-message-id={m.id} className={`ai-msg ai-msg-${m.role}${m.error ? ' is-error' : ''}${highlightedMessages.includes(m.id) ? ' is-source' : ''}`}>
                <div className="ai-msg-role">{m.role === 'user' ? '你' : 'AI'}</div>
                {m.tool && !progress && (
                  <div className="ai-tool-status">
                    <span className="ai-tool-spinner" /> 正在{m.tool}…
                  </div>
                )}
                {m.content ? (
                  <MessageBody
                    content={m.content}
                    nodeTitles={nodeTitles}
                    projectId={projectId}
                    boardId={boardId}
                  />
                ) : m.streaming && !m.tool ? (
                  <div className="ai-typing"><span></span><span></span><span></span></div>
                ) : null}
                {m.pause && <div className="ai-reply-pause">
                  <span role="status">{m.pause}</span>
                  {m.id === messages.at(-1)?.id && <button type="button" className="ai-btn-secondary"
                    disabled={interactionLocked || !configured || !!input.trim()}
                    onClick={() => {
                      const previous = messages.at(-2);
                      const original = previous?.role === 'user' ? `请按消息 ID ${previous.id} 核对上一次的原始提问。` : '';
                      const boardCheck = settings.shareBoard ? '先检查当前白板和已保存回执，只补齐遗漏的操作。' : '先核对已经回答的内容。';
                      setInput(`继续上次暂停的任务。${original}${boardCheck}请说明这次完成的内容和仍待处理的事项。`);
                      inputRef.current?.focus();
                    }}>继续未完成部分</button>}
                </div>}
                {capturableIds.has(m.id) && <details className={`ai-message-tools${selectedMessages.has(m.id) ? ' is-selected' : ''}`}>
                  <summary aria-label="消息操作">{selectedMessages.has(m.id) ? '已选择' : null}<MoreHorizontal size={16} aria-hidden="true"/></summary>
                  <div className="ai-capture-actions">
                    <label><input type="checkbox" aria-label="选择这轮问答" disabled={interactionLocked} checked={selectedMessages.has(m.id)} onChange={() => setSelectedMessages(prev => { const next = new Set(prev); for(const message of captureTurnsForSelection(messages,new Set([m.id]))){if(prev.has(m.id))next.delete(message.id);else next.add(message.id);}return next; })} /> 选入笔记</label>
                    {m.role === 'assistant' && <button type="button" className="ai-btn-secondary" disabled={interactionLocked} onClick={() => void saveSelection(new Set([m.id]))}>保存这轮问答</button>}
                  </div>
                </details>}
              </div>
            ))}
          </div>

          <div className="ai-composer">
            {knowledgePreview && <div className="ai-knowledge-preview" role="dialog" aria-label="本次知识引用">
              <div className="ai-reference-heading"><strong>参考你的知识</strong><span>{knowledgePreview.refs.length} 条</span></div>
              <div className="ai-reference-list">{knowledgePreview.refs.map(ref => <details key={ref.entryId}><summary><span className="ai-reference-title">{ref.title}</span><small>{ref.kind === 'material' ? '材料' : ref.kind === 'experience' ? '经验' : '理解'}{ref.truncated ? ' · 节选' : ''}</small></summary><div className="ai-reference-content"><p>{ref.excerpt}</p>{ref.source && <p className="ai-reference-source">{ref.source}</p>}<button type="button" className="ai-btn-secondary" aria-label="查看知识版本" onClick={() => void openKnowledge(ref.entryId, ref.revisionId).catch(e => setCaptureStatus(String(e)))}>查看原文 ↗</button></div></details>)}</div>
              <div className="ai-reference-footer"><span>将随问题发送</span><button type="button" className="ai-btn-secondary" onClick={() => setKnowledgePreview(undefined)}>取消</button><button type="button" className="ai-btn-primary" disabled={busy} onClick={() => void send(knowledgePreview)}>确认并发送</button></div>
            </div>}
            {!!selectedMessages.size && <div className="ai-capture-actions ai-selection-actions">
              <span>已选 {selectedTurnCount} 轮问答</span>
              <button type="button" className="ai-btn-secondary" disabled={interactionLocked || !selectedMessages.size} onClick={() => { const selected = messages.filter(m => selectedMessages.has(m.id) && !m.streaming && !m.error); if (selected.length) void openKnowledge(undefined, undefined, { title: `${boardName} · 讨论材料`.slice(0,200), body: selected.map(m => `## ${m.role === 'user' ? '我的问题' : 'AI 回答'}\n\n${m.content}`).join('\n\n'), source: `白板讨论 ${boardId} · 保留 AI 来源`, authorship: selected.some(m => m.role === 'assistant') ? 'ai_adopted' : 'user' }).catch(e => setCaptureStatus(String(e))); }}>存入知识库</button>
              <button type="button" className="ai-btn-secondary" disabled={interactionLocked} onClick={() => void saveSelection(selectedMessages)}>保存为节点</button>
            </div>}
            {messages.length > 0 && <details className="ai-conversation-tools">
              <summary>对话操作</summary>
              <div className="ai-conversation-action-list">
                <div className="ai-conversation-action">
                  <span>导出文件</span>
                  <button type="button" className="ai-btn-secondary" onClick={() => void exportTranscript()}>导出当前对话 Markdown</button>
                </div>
                <div className="ai-conversation-action">
                  <span>把本对话存为新节点</span>
                  <select aria-label="新节点的来源节点" disabled={interactionLocked} value={captureParent} onChange={e => setCaptureParent(e.target.value)}>
                    <option value="">独立节点</option>{board?.nodes.map(n => <option key={n.id} value={n.id}>接在：{n.title || '无标题节点'}</option>)}
                  </select>
                  <button type="button" className="ai-btn-secondary" disabled={interactionLocked || !captureTurns.length} onClick={() => void saveSelection(new Set(messages.map(m => m.id)))}>保存全部问答</button>
                </div>
                <div className="ai-conversation-action">
                  <span>{selectedMessages.size ? '把所选问答存为已有节点的文档' : '把本对话存为已有节点的文档'}</span>
                  <select aria-label="文档保存到" disabled={interactionLocked} value={documentTarget} onChange={e => setDocumentTarget(e.target.value)}>
                    <option value="">选择已有节点</option>{board?.nodes.map(n => <option key={n.id} value={n.id}>{n.title || '无标题节点'}</option>)}
                  </select>
                  <button type="button" className="ai-btn-secondary" disabled={interactionLocked || !documentTarget || !captureTurns.length} onClick={() => void saveSelection(selectedMessages.size ? selectedMessages : new Set(messages.map(m => m.id)), documentTarget)}>存为节点文档</button>
                </div>
              </div>
            </details>}
            {timing && <ChatResponseTiming report={timing} progress={progress}/>}
            {loadError && <p className="ai-warn" role="alert">{loadError}</p>}
            {memory && <details className="ai-memory-details"><summary>对话记忆 · 原始问答保留</summary><p>AI整理了 {memory.cursor.index} 条较早消息{memory.cursor.offset>0?"及下一条的部分内容":""}；原始问答完整保留，准确引述时会重新查阅。</p>{(["requirements","conclusions","unresolved"] as const).map((key,index)=><section key={key}><strong>{["你的要求与理解","AI结论与建议","未决事项"][index]}</strong>{memory.content[key].map((item,i)=><p key={i}>{item.text} <button className="ai-btn-secondary" onClick={()=>{pendingMessageJump.current=item.sources;setHighlightedMessages([]);setMessages(prev=>prev.slice());}}>查看原文</button></p>)}</section>)}</details>}
            {captureStatus && <p role="status" className="ai-hint">{captureStatus}</p>}
            {transcriptError&&messages.some(m=>m.content)&&<button type="button" className="ai-btn-secondary" onClick={()=>void exportTranscript()}>导出当前对话 Markdown</button>}
            {transcriptError && <button type="button" className="ai-btn-secondary" disabled={savingTranscript} onClick={()=>void persist(messagesRef.current).then(async ok=>{if(ok){if(!requestActive.current&&!writeLock.current&&!pendingSaves.current)await releaseLease();setCaptureStatus('对话已保存。');}})}>重试保存对话</button>}
            {savedCapture && <div className="ai-capture-actions"><button type="button" className="ai-btn-secondary" onClick={()=>void openReaderWindow({projectId,boardId,...savedCapture}).catch(error=>setCaptureStatus(String(error)))}>打开已保存笔记</button></div>}
            {!configured && (
              <div className="ai-warn">
                先在右上角设置中连接 AI。
              </div>
            )}
            <div className="ai-composer-row">
              <textarea
                ref={inputRef}
                className="ai-input"
                placeholder={configured ? '写下你的问题…' : '请先连接 AI'}
                aria-label="输入问题"
                title="Enter 发送，Shift+Enter 换行"
                value={input}
                disabled={!configured || unlocking || savingCapture || writingBoard || preparing || savingTranscript || transcriptError || !loadedRef.current}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                rows={2}
              />
              {busy || preparing ? (
                <button type="button" className="ai-send is-stop" aria-label="停止" title="停止生成" disabled={savingTranscript} onClick={()=>void stop()}>
                  <Square size={15} fill="currentColor" aria-hidden="true"/>
                </button>
              ) : (
                <button
                  type="button"
                  className="ai-send"
                  aria-label="发送"
                  title="发送（Enter）"
                  onClick={() => void send()}
                  disabled={!configured || !input.trim() || interactionLocked || deletedConversation || !loadedRef.current}
                >
                  <ArrowUp size={19} strokeWidth={2} aria-hidden="true"/>
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
