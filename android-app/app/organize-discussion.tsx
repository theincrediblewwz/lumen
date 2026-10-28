import { useEffect, useRef, useState } from 'react';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { Alert, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WorkspaceButton, WorkspaceCard, WorkspaceField } from '@/components/workspace-controls';
import { getByokCredentials, getByokProfileStatus } from '@/ai/byok-profile';
import { streamDiscussion } from '@/ai/discussion-client';
import { getNoteDraft, noteSources, openNoteDraft, organizationMessages, saveOrganizedNoteAsNode, setNoteGeneration, updateNoteDraft, type NoteDraft } from '@/data/note-drafts';
import { colors } from '@/theme/tokens';

export default function OrganizeDiscussionScreen() {
  const { draftId } = useLocalSearchParams<{ draftId: string }>();
  const db = useSQLiteContext(); const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [parentId, setParentId] = useState<string | null>(null);
  const [choices, setChoices] = useState<{ id: string; title: string }[]>([]); const [picking, setPicking] = useState(false);
  const [preview, setPreview] = useState(false); const [previewText, setPreviewText] = useState(''); const [destination, setDestination] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const gate = useRef(false); const controller = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queued = useRef(Promise.resolve()); const current = useRef({ title: '', body: '', parentId: null as string | null });
  const draftRef = useRef<NoteDraft | null>(null); const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void (async () => {
      const value = await getNoteDraft(db, draftId);
      if (!value) throw new Error('草稿不存在或源对话已删除');
      if (!alive.current) return;
      draftRef.current = value; current.current = { title: value.title, body: value.body, parentId: value.parent_node_id };
      setDraft(value); setTitle(value.title); setBody(value.body); setParentId(value.parent_node_id);
      const rows = await db.getAllAsync<{ id: string; title: string }>('SELECT id,title FROM nodes WHERE project_id=(SELECT project_id FROM conversations WHERE id=?) ORDER BY title,id', value.conversation_id);
      if (alive.current) setChoices(rows);
    })().catch(e => { if (alive.current) setError(e.message); });
    return () => {
      alive.current = false; controller.current?.abort();
      if (timer.current) clearTimeout(timer.current);
      if (draftRef.current && draftRef.current.status !== 'saved' && !gate.current) {
        const value = { ...current.current };
        queued.current = queued.current.catch(() => undefined).then(() => updateNoteDraft(db, draftId, { title: value.title, body: value.body, parentNodeId: value.parentId }));
        void queued.current.catch(() => undefined);
      }
    };
  }, [db, draftId]);
  function schedule(next: { title: string; body: string; parentId: string | null }) {
    current.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush().catch(e => { if (alive.current) setError(e.message); }); }, 500);
  }
  function flush() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const value = { ...current.current };
    queued.current = queued.current.catch(() => undefined).then(() => updateNoteDraft(db, draftId, { title: value.title, body: value.body, parentNodeId: value.parentId }));
    return queued.current;
  }
  async function showPreview() {
    if (!draft || gate.current) return;
    try {
      await flush();
      const value = organizationMessages(draft);
      const status = await getByokProfileStatus();
      setDestination(status.hasApiKey && status.profile ? `${status.profile.label} · ${status.profile.baseUrl} · ${status.profile.model}` : '尚未连接个人 AI，可以返回手动整理');
      setPreviewText(value.preview); setPreview(true); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : '无法预览整理输入'); }
  }
  async function generate() {
    if (!draft || gate.current) return;
    gate.current = true; setBusy(true); setPreview(false); setError('');
    const prior = current.current.body; let received = ''; let writes = Promise.resolve(); let lastWrite = 0; let started = false;
    try {
      const status = await getByokProfileStatus();
      if (!status.hasApiKey || !status.profile) throw new Error('尚未连接个人 AI。可以手动整理，或先在 AI 设置中连接。');
      const credentials = await getByokCredentials();
      if (!credentials || credentials.profile.baseUrl !== status.profile.baseUrl || credentials.profile.model !== status.profile.model) throw new Error('AI 服务已改变，请重新预览');
      const request = organizationMessages(draft);
      await setNoteGeneration(db, draft.id, 'generating', ''); started = true;
      current.current.body = ''; setBody('');
      const abort = new AbortController(); controller.current = abort;
      const result = await streamDiscussion(credentials, request.messages, { signal: abort.signal, onText: text => {
        received = text; if (alive.current) setBody(text);
        if (Date.now() - lastWrite > 700) { lastWrite = Date.now(); const snapshot = text; writes = writes.then(() => setNoteGeneration(db, draft.id, 'generating', snapshot)); }
      } });
      await writes; await setNoteGeneration(db, draft.id, 'editing', result.text);
      current.current.body = result.text; if (alive.current) setBody(result.text);
    } catch (e) {
      await writes.catch(() => undefined);
      const retained = received || prior;
      if (started) await setNoteGeneration(db, draft.id, 'interrupted', retained).catch(() => undefined);
      current.current.body = retained; if (alive.current) { setBody(retained); setError(e instanceof Error ? e.message : '整理未完成；不会自动重试'); }
    } finally {
      gate.current = false; controller.current = null;
      if (alive.current) { setBusy(false); const updated = await getNoteDraft(db, draft.id).catch(() => null); if (updated) { draftRef.current = updated; setDraft(updated); } }
    }
  }
  async function save() {
    if (!draft || gate.current) return;
    gate.current = true; setBusy(true); setError('');
    try {
      if (draft.status !== 'saved') await flush(); const result = await saveOrganizedNoteAsNode(db, draft.id);
      const updated = await getNoteDraft(db, draft.id).catch(() => null); if (updated) draftRef.current = updated;
      Alert.alert(result.reused ? '笔记已经保存' : '笔记已保存为文档和节点', '选中的原始消息仍在对话中。', [
        { text: '阅读笔记', onPress: () => router.replace({ pathname: '/document/[id]', params: { id: result.documentId } }) },
        { text: '查看节点', onPress: () => router.replace({ pathname: '/project/[id]', params: { id: result.projectId, initialNodeId: result.nodeId ?? '', favoriteJump: '1' } }) },
      ]);
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败，未创建节点'); }
    finally { gate.current = false; setBusy(false); }
  }
  async function newDraft() {
    if (!draft || gate.current) return;
    try { if (draft.status !== 'saved') await flush(); const next = await openNoteDraft(db, draft.conversation_id, JSON.parse(draft.message_ids_json) as string[], true); router.replace({ pathname: '/organize-discussion', params: { draftId: next.id } }); }
    catch (e) { setError(e instanceof Error ? e.message : '无法新建草稿'); }
  }
  const sources = draft ? noteSources(draft) : [];
  return <View style={{ flex: 1, backgroundColor: colors.canvas }}><Stack.Screen options={{ title: '整理学习笔记' }} />
    <ScrollView keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 32, gap: 14 }}>
      {error ? <Text selectable accessibilityLiveRegion="polite" style={{ color: colors.coral, lineHeight: 22 }}>{error}</Text> : null}
      {!draft ? <Text style={{ color: colors.inkMuted }}>正在读取草稿…</Text> : <>
        <Text style={{ color: colors.inkMuted, lineHeight: 22 }}>草稿保存在本机。整理前可查看要发送的原文；保存后会创建新文档和节点，并保留对话来源。</Text>
        {draft.status === 'interrupted' ? <Text style={{ color: colors.coral }}>上次整理中断；已收到的内容仍可编辑，不会自动重试。</Text> : null}
        {busy || draft.status === 'saved' ? <><Text selectable style={{ color: colors.ink, lineHeight: 24 }}>{title}{'\n\n'}{body || '等待整理结果…'}</Text>{controller.current ? <WorkspaceButton secondary label="停止整理" onPress={() => controller.current?.abort()} /> : null}</> : <><WorkspaceField label="笔记与新节点标题" value={title} onChangeText={value => { setTitle(value); schedule({ title: value, body, parentId }); }} />
          <WorkspaceField label="Markdown 笔记正文" value={body} onChangeText={value => { setBody(value); schedule({ title, body: value, parentId }); }} multiline /></>}
        <WorkspaceButton secondary label={`连接到：${choices.find(choice => choice.id === parentId)?.title ?? '不连接节点'}`} disabled={busy || draft.status === 'saved'} onPress={() => setPicking(true)} />
        {draft.status !== 'saved' ? <><WorkspaceButton secondary label="暂存草稿" disabled={busy} onPress={() => void flush().then(() => setError('草稿已保存在本机')).catch(e => setError(e.message))} />
        <WorkspaceButton secondary label="预览 AI 整理输入" disabled={busy} onPress={() => void showPreview()} /></> : null}
        <WorkspaceButton label={busy ? '请稍候…' : '保存笔记并新建节点'} disabled={busy || !title.trim() || !body.trim()} onPress={() => void save()} />
        <WorkspaceButton secondary label="为同一段讨论另建草稿" disabled={busy} onPress={() => void newDraft()} />
        <Text style={{ color: colors.inkMuted }}>来源消息 · {sources.length} 条（按原对话顺序）</Text>
        {sources.map((source, index) => <WorkspaceCard key={source.id}><Text style={{ color: colors.ink, fontWeight: '700' }}>{index + 1}. {source.role === 'user' ? '我' : 'AI'}{source.status === 'interrupted' ? ' · 未完成' : ''}</Text><Text selectable numberOfLines={8} style={{ color: colors.inkMuted, lineHeight: 22 }}>{source.body}</Text></WorkspaceCard>)}
      </>}
    </ScrollView>
    <Modal visible={preview} animationType="slide" onRequestClose={() => setPreview(false)}><View style={{ flex: 1, padding: 18, paddingTop: insets.top + 18, paddingBottom: insets.bottom + 18, backgroundColor: colors.canvas, gap: 12 }}><Text style={{ fontSize: 20, fontWeight: '700', color: colors.ink }}>发送给个人 AI 的原文</Text><Text style={{ color: colors.inkMuted }}>{destination}{'\n'}仅在点击下方按钮后发送。服务可能计费；取消或超时不会自动重试。新结果会替换当前草稿正文，保存的节点不受影响。</Text><ScrollView><Text selectable style={{ color: colors.ink, lineHeight: 21 }}>{previewText}</Text></ScrollView><WorkspaceButton label="确认发送并整理" onPress={() => void generate()} /><WorkspaceButton secondary label="返回编辑" onPress={() => setPreview(false)} /></View></Modal>
    <Modal visible={picking} animationType="slide" onRequestClose={() => setPicking(false)}><View style={{ flex: 1, padding: 18, paddingTop: insets.top + 18, paddingBottom: insets.bottom + 18, backgroundColor: colors.canvas, gap: 10 }}><Text style={{ fontSize: 20, fontWeight: '700', color: colors.ink }}>选择连接节点</Text><ScrollView><Pressable onPress={() => { setParentId(null); schedule({ title, body, parentId: null }); setPicking(false); }} style={{ padding: 15 }}><Text>不连接节点</Text></Pressable>{choices.map(choice => <Pressable key={choice.id} onPress={() => { setParentId(choice.id); schedule({ title, body, parentId: choice.id }); setPicking(false); }} style={{ padding: 15 }}><Text style={{ color: colors.ink }}>{choice.title}</Text></Pressable>)}</ScrollView><WorkspaceButton secondary label="取消" onPress={() => setPicking(false)} /></View></Modal>
  </View>;
}
