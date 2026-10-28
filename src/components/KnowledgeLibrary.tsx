import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, FileText, Link2, MoreHorizontal, PencilLine, Search, X } from 'lucide-react';
import { ConfirmAction } from './ConfirmAction';
import { loadAiSettingsDeferred } from '../ai/aiSettings';
import type { BoardFile } from '../api';
import { renderMarkdown } from '../reader/engine';
import { typesetMath } from '../reader/reader';
import { loadKnowledge, saveKnowledge, openKnowledge, exportKnowledgeFile, pickKnowledgeFile, type KnowledgeSnapshot, type KnowledgeDraft } from '../knowledge/store';
import { emptyKnowledgeLibrary, knowledgeId, knowledgeKindLabel, KNOWLEDGE_KINDS, saveKnowledgeInLibrary,
  type KnowledgeEntry, type KnowledgeKind, type KnowledgePolicy } from '../knowledge/core';
import './knowledge.css';

export function KnowledgeLibrary({ boardId, boardName, boardPolicy, indexCollapsed = false, entryId, revisionId, draft, onClose, onEditingChange, onNavigationReady }: {
  boardId?: string; boardName?: string; boardPolicy?: BoardFile['_sync_content_policy']; indexCollapsed?: boolean; entryId?: string; revisionId?: string; draft?: KnowledgeDraft; onClose: () => void; onEditingChange: (editing: boolean) => void;
  onNavigationReady: (handler: ((accept: () => void) => void) | null) => void;
}) {
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot>({ revision: '', library: emptyKnowledgeLibrary() });
  const [selected, setSelected] = useState(entryId), [oldRevision, setOldRevision] = useState(revisionId);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<KnowledgeKind | ''>(''), [archived, setArchived] = useState(false);
  const [editor, setEditor] = useState<{ original?: KnowledgeEntry; kind: KnowledgeKind; title: string; body: string; source: string; basis: string[]; authorship?: KnowledgeEntry['authorship'] }>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const mutationLock=useRef(false);
  const loadSequence = useRef(0);
  const [loading, setLoading] = useState(true);
  const [boardReadAllowed, setBoardReadAllowed] = useState(() => loadAiSettingsDeferred().shareBoard);
  const workspace = useRef<HTMLElement>(null), readingPane = useRef<HTMLElement>(null);
  const [confirmation, setConfirmation] = useState<{ message: string; accept: () => void | Promise<void> }>();
  const cancelConfirmation = useCallback(() => setConfirmation(undefined), []);
  useEffect(() => {
    const permission = () => setBoardReadAllowed(loadAiSettingsDeferred().shareBoard);
    const outside = (event: MouseEvent) => workspace.current?.querySelectorAll<HTMLDetailsElement>('.knowledge-menu[open]').forEach(menu => { if (!menu.contains(event.target as Node)) menu.open = false; });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return;
      const menu = workspace.current?.querySelector<HTMLDetailsElement>('.knowledge-menu[open]');
      if (menu) { event.preventDefault(); event.stopImmediatePropagation(); menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus(); }
    };
    window.addEventListener('storage', permission); window.addEventListener('focus', permission);
    window.addEventListener('mousedown', outside); window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('storage', permission); window.removeEventListener('focus', permission); window.removeEventListener('mousedown', outside); window.removeEventListener('keydown', escape, true); };
  }, []);
  const reload = useCallback(async () => {
    const sequence = ++loadSequence.current; setLoading(true);
    try { const next = await loadKnowledge(); if (sequence === loadSequence.current) { setSnapshot(next); setError(''); } }
    catch (e) { if (sequence === loadSequence.current) throw e; }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }, []);
  useEffect(() => { void reload().catch(e => setError(String(e))); return () => { loadSequence.current++; }; }, [reload]);
  const editorState = useRef(editor); editorState.current = editor;
  useEffect(() => {
    const open = () => { setSelected(entryId); setOldRevision(revisionId); setQuery(''); setFilter(''); setArchived(false); setEditor(draft ? { ...draft, kind: 'material', basis: [] } : undefined); };
    if (editorState.current) setConfirmation({ message: '放弃尚未保存的修改并打开新内容？', accept: open });
    else open();
  }, [entryId, revisionId, draft]);
  useEffect(() => {
    const notify = () => { if (!editor && !mutationLock.current) void reload().catch(e => setError(String(e))); };
    window.addEventListener('lumen:knowledge-changed', notify);
    return () => window.removeEventListener('lumen:knowledge-changed', notify);
  }, [reload, editor]);
  useEffect(() => {
    if (!editor) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [editor]);
  useLayoutEffect(() => {
    onEditingChange(Boolean(editor));
    return () => onEditingChange(false);
  }, [editor, onEditingChange]);
  const { library } = snapshot;
  const current = library.entries.find(row => row.id === selected);
  const historical = oldRevision && current ? library.revisions.find(row => row.id === oldRevision && row.entry_id === current.id) : undefined;
  const reading = oldRevision ? historical : current;
  const html = useMemo(() => reading ? renderMarkdown(reading.body, undefined, { guessMath: false }).html : '', [reading]);
  const article = useRef<HTMLDivElement>(null);
  useEffect(() => { if (article.current) { const handle = typesetMath(article.current); return () => handle.cancel(); } }, [html, editor]);
  const matches = (text: string, kind: KnowledgeKind | '', inArchive: boolean) => library.entries.filter(row => Boolean(row.archived) === inArchive && (!kind || row.kind === kind) && `${row.title}\n${row.body}\n${row.source}`.toLowerCase().includes(text.trim().toLowerCase()));
  const rows = matches(query, filter, archived);
  const firstEntry = rows[0]?.id;
  useEffect(() => { if (!selected && !entryId && !editor && !query && !filter && !archived && firstEntry) setSelected(firstEntry); }, [selected, entryId, editor, query, filter, archived, firstEntry]);
  useLayoutEffect(() => { if (readingPane.current) readingPane.current.scrollTop = 0; }, [selected, oldRevision, Boolean(editor)]);
  function updateListing(text = query, kind = filter, inArchive = archived) {
    setQuery(text); setFilter(kind); setArchived(inArchive);
    if (!editorState.current) { setSelected(matches(text, kind, inArchive)[0]?.id); setOldRevision(undefined); }
  }
  const policy = library.settings.find(row => row.project_id === boardId)?.policy ?? 'disabled';
  function edit(row?: KnowledgeEntry) { setEditor({ original: row, kind: row?.kind ?? 'understanding', title: row?.title ?? '', body: row?.body ?? '', source: row?.source ?? '', basis: row ? JSON.parse(row.basis_json) : [] }); setError(''); }
  async function mutate(next: typeof library) {
    if (loading) throw Error('请等待读取知识完成，再保存。');
    if (mutationLock.current) throw Error('正在保存知识，请稍后重试。');mutationLock.current=true; setBusy(true); setError('');
    loadSequence.current++;
    try { const revision = await saveKnowledge(next, snapshot.revision); setSnapshot({ library: next, revision }); }
    catch (e) { setError(String(e)); throw e; } finally { mutationLock.current=false;setBusy(false); }
  }
  async function save(asNew = false) {
    if (!editor) return;
    const savingEditor=editor;
    try {
      const result = saveKnowledgeInLibrary(library, { id: asNew ? undefined : editor.original?.id,
        expectedRevision: editor.original?.revision_id, kind: editor.kind, title: editor.title, body: editor.body,
        source: editor.source, basisIds: editor.basis, authorship: editor.authorship ?? editor.original?.authorship });
      await mutate(result.library);if(editorState.current===savingEditor){setSelected(result.entry.id); setOldRevision(undefined); setEditor(undefined); setQuery(''); setFilter(''); setArchived(false);}else setError('较早版本已保存；当前新改动仍保留为草稿，请核对后保存。');
    } catch (e) { setError(String(e)); }
  }
  async function setPolicy(policy: KnowledgePolicy) {
    if (!boardId) return;
    const row = { id: boardId, project_id: boardId, policy, updated_at: new Date().toISOString() };
    await mutate({ ...library, settings: [...library.settings.filter(item => item.project_id !== boardId), row] }).catch(() => undefined);
  }
  async function bind(row: KnowledgeEntry) {
    if (!boardId) return;
    const existing = library.bindings.find(item => item.project_id === boardId && item.entry_id === row.id && !item.node_id);
    await mutate({ ...library, bindings: existing ? library.bindings.filter(item => item.id !== existing.id) : [...library.bindings, { id: knowledgeId('binding'), project_id: boardId, entry_id: row.id, node_id: null, created_at: new Date().toISOString() }] }).catch(() => undefined);
  }
  const leaveWriting = useCallback((accept: () => void) => { if(mutationLock.current){setError('正在保存知识，请完成后再切换。');return;}if (editorState.current) setConfirmation({ message: '放弃尚未保存的修改？', accept }); else accept(); }, []);
  useLayoutEffect(() => {
    onNavigationReady(leaveWriting);
    return () => onNavigationReady(null);
  }, [onNavigationReady, leaveWriting]);
  function close() { leaveWriting(onClose); }
  const bound = current && library.bindings.some(row => row.project_id === boardId && row.entry_id === current.id && !row.node_id);
  const sourceRestricted = boardPolicy?.mode === 'summary' && !boardPolicy.allowOutsideKnowledge;
  const policyLabel = policy === 'disabled' ? '关闭' : !boardReadAllowed ? '读取未开启' : sourceRestricted ? '资料范围受限' : policy === 'allowed' ? '按需' : '优先';
  const entryRow = (row: KnowledgeEntry) => <button className={'knowledge-entry' + (selected === row.id ? ' is-selected' : '')} aria-pressed={selected === row.id} key={row.id} onClick={() => leaveWriting(() => { setEditor(undefined); setSelected(row.id); setOldRevision(undefined); })}>
    <small>{knowledgeKindLabel(row.kind)}{row.archived ? ' · 已归档' : ''}</small><span>{row.title}</span>
  </button>;
  return <main ref={workspace} className={'knowledge-workspace' + (indexCollapsed ? ' is-index-collapsed' : '')} tabIndex={-1} onClick={event => {
    const button = (event.target as HTMLElement).closest('button');
    if (button?.closest('.knowledge-menu-panel')) { const menu = button.closest('details'); if (menu) menu.open = false; }
  }}>
    {confirmation && <ConfirmAction message={confirmation.message} confirmLabel="确认" onCancel={cancelConfirmation} onConfirm={() => { const action = confirmation.accept; setConfirmation(undefined); void Promise.resolve().then(action).catch(e => setError(String(e))); }} />}
    <header className="knowledge-header">
      <div className="knowledge-index-cap" aria-hidden="true" />
      <div className="knowledge-header-main">
        <div className="knowledge-heading"><button className="knowledge-back" aria-label="返回白板" onClick={close}><ArrowLeft size={16} aria-hidden="true" />返回白板</button><h1>知识库</h1></div>
        <div className="knowledge-toolbar">
          <button className="btn btn-primary knowledge-create" aria-label="写下理解" disabled={busy || loading} onClick={() => leaveWriting(() => edit())}><PencilLine size={16} aria-hidden="true" /><span>写下理解</span></button>
          <details className="knowledge-menu"><summary aria-label="知识库更多操作"><MoreHorizontal size={19} aria-hidden="true" /></summary><div className="knowledge-menu-panel">
            {boardId && <fieldset className="knowledge-global-policy"><legend>白板 · {boardName ?? '当前白板'}</legend><p className="knowledge-permission-note">AI引用：{policyLabel}</p>{([['disabled','不引用'],['allowed','允许按问题检索'],['priority','优先参考指定条目']] as const).map(([value,label]) => <label className="knowledge-check" key={value}><input type="radio" name="knowledge-policy-global" disabled={busy || loading} checked={policy === value} onChange={() => void setPolicy(value)} />{label}</label>)}{sourceRestricted && <p className="knowledge-permission-note">本板限制资料外知识，当前不会发送知识库内容。</p>}{!boardReadAllowed && <p className="knowledge-permission-note">AI设置中的白板读取尚未开启。</p>}</fieldset>}
            <label className="knowledge-check"><input type="checkbox" checked={archived} onChange={e => updateListing(query, filter, e.target.checked)} />查看已归档</label>
            <button className="btn" disabled={busy || loading || !!editor} onClick={() => void exportKnowledgeFile().catch(e => setError(String(e)))}>导出知识库</button>
            <button className="btn" disabled={busy || loading || !!editor} onClick={() => void (async () => { try { const copy = await pickKnowledgeFile(); if (!copy) return; setConfirmation({ message: '新增 ' + copy.entries.length + ' 条知识副本，保留已有内容。白板权限需要重新设置。', accept: async () => { await mutate({ ...library, entries: [...library.entries, ...copy.entries], revisions: [...library.revisions, ...copy.revisions] }); } }); } catch (e) { setError(String(e)); } })()}>导入知识副本</button>
          </div></details>
        </div>
      </div>
    </header>
    {error && <div className="knowledge-error" role="alert">{error}<button className="btn" disabled={busy} onClick={() => void reload().catch(e => setError(String(e)))}>重新加载资料（保留草稿）</button></div>}
    <div className="knowledge-columns">
      <aside className="knowledge-list" aria-label="知识索引" hidden={indexCollapsed}>
        <div className="knowledge-search-box"><Search size={16} aria-hidden="true" /><input className="input knowledge-search" aria-label="搜索知识" placeholder="搜索知识" value={query} onChange={e => updateListing(e.target.value)} />{query && <button className="knowledge-clear" aria-label="清除搜索" onClick={() => updateListing('')}><X size={14} aria-hidden="true" /></button>}</div>
        <div className="knowledge-filters" role="group" aria-label="知识类型筛选">{(['', ...KNOWLEDGE_KINDS] as const).map(kind => <button key={kind} aria-pressed={filter === kind} onClick={() => updateListing(query, kind)}>{kind ? knowledgeKindLabel(kind) : '全部'}</button>)}</div>
        {archived && <div className="knowledge-list-notice">已归档知识<button onClick={() => updateListing(query, filter, false)}>返回全部</button></div>}
        {current && !editor && !rows.some(row => row.id === current.id) && <div className="knowledge-pinned"><small>当前打开</small>{entryRow(current)}</div>}
        <div className="knowledge-entries">{rows.map(entryRow)}{!rows.length && <div className="knowledge-empty"><p>{query || filter ? '没有匹配的知识。' : archived ? '没有已归档的知识。' : '写下第一个理解。'}</p>{(query || filter) && <button className="knowledge-text-action" onClick={() => updateListing('', '')}>清除筛选</button>}</div>}</div>
      </aside>
      <section ref={readingPane} className="knowledge-reading" aria-label={editor ? '知识写作' : '知识阅读'}>
        {editor ? <div className="knowledge-editor">
          <label className="knowledge-editor-kind">内容类型<select className="input knowledge-kind" disabled={busy} aria-label="内容类型" value={editor.kind} onChange={e => setEditor({ ...editor, kind: e.target.value as KnowledgeKind })}>{KNOWLEDGE_KINDS.map(kind => <option key={kind} value={kind}>{knowledgeKindLabel(kind)}</option>)}</select></label>
          <input className="knowledge-title-input" disabled={busy} aria-label="知识标题" placeholder="标题" maxLength={200} value={editor.title} onChange={e => setEditor({ ...editor, title: e.target.value })} />
          <textarea className="knowledge-body-input" disabled={busy} aria-label="知识正文" placeholder="用自己的话写下理解、疑问或经验" value={editor.body} onChange={e => setEditor({ ...editor, body: e.target.value })} />
          <details className="knowledge-source-details"><summary>出处与依据</summary>
            <textarea className="input knowledge-source" disabled={busy} aria-label="知识出处" placeholder="出处或背景（可选）" value={editor.source} onChange={e => setEditor({ ...editor, source: e.target.value })} />
            {editor.kind !== 'material' && library.entries.filter(row => row.kind === 'material' && !row.archived && row.id !== editor.original?.id).map(row => <label className="knowledge-check" key={row.id}><input type="checkbox" disabled={busy} checked={editor.basis.includes(row.id)} onChange={e => setEditor({ ...editor, basis: e.target.checked ? [...editor.basis, row.id] : editor.basis.filter(id => id !== row.id) })} />{row.title}</label>)}
          </details>
          <div className="knowledge-actions"><button className="btn btn-primary" disabled={busy || loading || !editor.title.trim() || !editor.body.trim()} onClick={() => void save()}>{editor.authorship === 'ai_adopted' ? '采用并保存' : '保存'}</button>{error && <button className="btn" disabled={busy} onClick={() => void save(true)}>保存为新条目</button>}<button className="btn" disabled={busy} onClick={() => leaveWriting(() => { setEditor(undefined); if (!rows.some(row => row.id === selected)) { setSelected(rows[0]?.id); setOldRevision(undefined); } })}>取消</button></div>
        </div> : reading ? <article>
          <div className="knowledge-reader-tools"><small>{knowledgeKindLabel(reading.kind)}{historical ? ' · 当时的引用版本' : current?.archived ? ' · 已归档' : ''}</small><div className="knowledge-toolbar">
            {historical ? <button className="knowledge-text-action" onClick={() => setOldRevision(undefined)}>当前版本</button> : current && <><button className="knowledge-edit" aria-label="编辑" title="编辑" disabled={busy} onClick={() => edit(current)}><PencilLine size={17} aria-hidden="true" /></button>
              <details className="knowledge-menu"><summary aria-label="条目更多操作"><MoreHorizontal size={19} aria-hidden="true" /></summary><div className="knowledge-menu-panel"><button className="btn" disabled={busy} onClick={() => void mutate({ ...library, entries: library.entries.map(row => row.id === current.id ? { ...row, archived: row.archived ? 0 : 1, updated_at: new Date().toISOString() } : row) }).catch(() => undefined)}>{current.archived ? '恢复到列表' : '归档'}</button>{library.revisions.filter(row => row.entry_id === current.id && row.id !== current.revision_id).map(row => <button className="btn" key={row.id} onClick={() => setOldRevision(row.id)}>旧版本 · {row.created_at.slice(0, 16).replace('T', ' ')}</button>)}</div></details>
            </>}
          </div></div>
          <div className="knowledge-title-row"><h2>{reading.title}</h2>
            {boardId && !historical && current && <div className="knowledge-reference-bar">
              <span className="knowledge-board-name" title={boardName ?? '当前白板'}><Link2 size={14} aria-hidden="true" />用于白板 · {boardName ?? '当前白板'}</span>
              <button className="knowledge-bind" disabled={busy || loading || Boolean(current.archived && !bound)} title={current.archived && !bound ? '恢复到列表后即可引用' : undefined} onClick={() => void bind(current)}><Link2 size={14} aria-hidden="true" />{bound ? '解除引用' : '引用到白板'}</button>
              <details className="knowledge-menu knowledge-policy"><summary aria-label="白板引用设置">AI引用：{policyLabel}<ChevronDown size={12} aria-hidden="true" /></summary><fieldset className="knowledge-menu-panel"><legend>此白板如何参考知识库</legend>
                <p className="knowledge-permission-note">{bound ? '本条已关联。关联不会自动开启 AI 引用。' : '关联知识和允许 AI 使用分别设置。'}</p>
                {([['disabled', '不引用'], ['allowed', '允许按问题检索'], ['priority', '优先参考指定条目']] as const).map(([value, label]) => <label className="knowledge-check" key={value}><input type="radio" name="knowledge-policy" disabled={busy || loading} checked={policy === value} onChange={() => void setPolicy(value)} />{label}</label>)}
                {!boardReadAllowed && <p className="knowledge-permission-note">AI设置中的“允许读取白板”尚未开启，当前不会向AI发送知识。</p>}
                {sourceRestricted && <p className="knowledge-permission-note">本板限制资料外知识，当前不会发送知识库内容。</p>}
              </fieldset></details>
            </div>}
          </div>
          {bound && !historical && <p className="knowledge-bound-note">已关联此白板{policy === 'disabled' ? '，AI引用仍关闭。' : '。'}</p>}
          {Boolean(current?.archived) && !historical && <p className="knowledge-archived-note">本条已归档，不参与知识主检索；作为其他理解的依据时仍保留。</p>}
          {!boardId && <p className="knowledge-detached-note">独立保存的知识。返回并打开白板后，可将它引用到白板。</p>}
          <div ref={article} className="md-body" onClick={event => { const href = (event.target as HTMLElement).closest('a')?.getAttribute('href'); const match = href?.match(/^learnstuff-knowledge:\/\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/u); if (match) { event.preventDefault(); void openKnowledge(match[1], match[2]).catch(e => setError(String(e))); } }} dangerouslySetInnerHTML={{ __html: html }} />
          {reading.authorship === 'ai_adopted' && <p className="knowledge-provenance">AI 内容 · 已由你采用</p>}
          {(reading.source || JSON.parse(reading.basis_json).length > 0) && <details className="knowledge-source-details" open><summary>出处与依据</summary>{reading.source && <p className="knowledge-provenance">{reading.source}</p>}{(JSON.parse(reading.basis_json) as string[]).map(id => <button className="knowledge-basis-link" key={id} onClick={() => { setSelected(id); setOldRevision(undefined); }}><FileText size={15} aria-hidden="true" />{library.entries.find(row => row.id === id)?.title ?? '尚未同步的依据'}</button>)}</details>}
        </article> : <div className="knowledge-reading-empty"><FileText size={28} strokeWidth={1.4} aria-hidden="true" /><p>{loading ? '正在读取知识…' : selected ? '引用版本尚未到齐，请同步完整知识库后再打开。' : query || filter ? '没有匹配的知识，试试其他关键词。' : '选择一条知识，或写下新的理解。'}</p></div>}
      </section>
    </div>
  </main>;
}
