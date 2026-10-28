import {documentText} from '@/data/rich-document';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { router, Stack, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { Alert, Pressable, ScrollView, Switch, Text, TextInput, View, StyleSheet } from 'react-native';
import { usePreventRemove } from '@react-navigation/native';
import { MarkdownContent } from '@/components/markdown-content';
import { AppIcon } from '@/components/app-icon';
import { QuietDisclosure } from '@/components/quiet-disclosure';
import { KnowledgeReferenceOptions } from '@/components/knowledge-reference-options';
import { colors, radii } from '@/theme/tokens';
import { onSyncUpdate } from '@/sync/runtime';
import { exportKnowledgeFile, pickKnowledgeFile, importKnowledgeFile } from '@/data/knowledge-library-transfer';
import { loadKnowledgeLibrary, saveKnowledgeEntry, archiveKnowledgeEntry, setKnowledgePolicy, bindKnowledgeEntry } from '@/data/knowledge-library';
import { emptyKnowledgeLibrary, KNOWLEDGE_KINDS, knowledgeKindLabel, type KnowledgeKind, type KnowledgeLibrary, type KnowledgeEntry } from '@/data/knowledge-library-core';

function QuietAction({ label, onPress, disabled = false, expanded }: { label: string; onPress: () => void; disabled?: boolean; expanded?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled, expanded }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: 4, opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}><Text style={{ color: colors.inkMuted, fontSize: 14 }}>{label}</Text></Pressable>;
}

export default function KnowledgeLibraryScreen() {
  const params = useLocalSearchParams<{ entryId?: string; revisionId?: string; projectId?: string; nodeId?: string; fromDocumentId?: string; returnTo?: string }>();
  const db = useSQLiteContext(), navigation = useNavigation();
  const [library, setLibrary] = useState<KnowledgeLibrary>(emptyKnowledgeLibrary);
  const selected = params.entryId ?? null;
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<KnowledgeKind | null>(null), [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState(false), [editId, setEditId] = useState<string>(), [revision, setRevision] = useState<string>();
  const [kind, setKind] = useState<KnowledgeKind>('understanding'), [title, setTitle] = useState(''), [body, setBody] = useState(''), [source, setSource] = useState('');
  const [basis, setBasis] = useState<string[]>([]), [origin, setOrigin] = useState<KnowledgeEntry['authorship']>('user');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [sourceRestricted, setSourceRestricted] = useState(false);
  const reload = useCallback(async () => {
    const value = await loadKnowledgeLibrary(db);
    setLibrary(value);
    if (params.projectId) {
      const project = await db.getFirstAsync<{ mode: string; allow_outside_knowledge: number }>('SELECT mode,allow_outside_knowledge FROM projects WHERE id=?', params.projectId);
      setSourceRestricted(project?.mode === 'summary' && !project.allow_outside_knowledge);
    } else setSourceRestricted(false);
  }, [db, params.projectId]);
  useFocusEffect(useCallback(() => { void reload().catch(e => setError(e.message)); }, [reload]));
  useEffect(() => onSyncUpdate(() => { void reload().catch(e => setError(e.message)); }), [reload]);
  usePreventRemove(editing, ({ data }) => Alert.alert('保留当前写作', '返回会离开尚未保存的内容。', [
    { text: '继续写', style: 'cancel' }, { text: '放弃修改并返回', style: 'destructive', onPress: () => { setEditing(false); navigation.dispatch(data.action); } },
  ]));
  const current = library.entries.find(row => row.id === selected);
  const historical = params.revisionId && current ? library.revisions.find(row => row.id === params.revisionId && row.entry_id === current.id) : undefined;
  const reading = params.revisionId ? historical : current;
  const missingReference = Boolean((selected && !current) || (params.revisionId && !historical));
  const policy = library.settings.find(row => row.project_id === params.projectId)?.policy ?? 'disabled';
  const rows = useMemo(() => library.entries.filter(row => Boolean(row.archived) === archived && (!filter || row.kind === filter)
    && (!query.trim() || `${row.title}\n${row.body}\n${row.source}`.toLowerCase().includes(query.trim().toLowerCase()))), [library, archived, filter, query]);
  function edit(row?: KnowledgeEntry) {
    setEditId(row?.id); setRevision(row?.revision_id); setKind(row?.kind ?? 'understanding'); setTitle(row?.title ?? '');
    setBody(row?.body ?? ''); setSource(row?.source ?? ''); setBasis(row ? JSON.parse(row.basis_json) : []); setOrigin(row?.authorship ?? 'user'); setEditing(true); setError(''); setToolsOpen(false);
  }
  useEffect(() => {
    if (!params.fromDocumentId) return;
    let active = true;
    void db.getFirstAsync<{ title: string; body: string; origin: string; project_id: string }>('SELECT title,body,origin,project_id FROM documents WHERE id=?', params.fromDocumentId).then(row => {
      if (!active || !row) return;
      setKind('material'); setTitle(row.title); setBody(documentText(row.body)); setSource(`文字摘录（原件和图片仍保留在节点） · 学习文档 ${params.fromDocumentId} · 白板 ${row.project_id} · 原始作者 ${row.origin}`);
      setOrigin(row.origin === 'ai' ? 'ai_adopted' : row.origin === 'learner' ? 'user' : 'source'); setEditing(true);
    }).catch(e => setError(e.message));
    return () => { active = false; };
  }, [db, params.fromDocumentId]);
  async function act(action: () => Promise<unknown>) {
    if (busy) return; setBusy(true); setError('');
    try { await action(); await reload(); } catch (e) { setError(e instanceof Error ? e.message : '保存失败，内容已保留'); } finally { setBusy(false); }
  }
  async function save() {
    await act(async () => {
      const saved = await saveKnowledgeEntry(db, { id: editId, expectedRevision: revision, kind, title, body, source, basisIds: basis,
        authorship: kind === 'material' && origin === 'user' ? 'source' : origin });
      router.setParams({ entryId: saved.id, revisionId: undefined }); setEditing(false);
    });
  }
  function returnToWorkspace() {
    if (router.canGoBack()) router.back();
    else if (params.projectId && params.returnTo === 'settings') router.replace({ pathname: '/project-settings', params: { projectId: params.projectId } });
    else if (params.projectId) router.replace({ pathname: '/project/[id]', params: { id: params.projectId } });
    else router.replace('/');
  }
  const boundCount = new Set(library.bindings.filter(row => row.project_id === params.projectId && library.entries.some(entry => entry.id === row.entry_id && !entry.archived)).map(row => row.entry_id)).size;
  const isBound = current && library.bindings.some(row => row.project_id === params.projectId && row.entry_id === current.id && row.node_id === (params.nodeId ?? null));
  const toList = () => { setToolsOpen(false); router.setParams({ entryId: undefined, revisionId: undefined }); };
  const cancelEditing = () => Alert.alert('放弃这次修改？', '尚未保存的写作会丢失。', [{ text: '继续写', style: 'cancel' }, { text: '放弃修改', onPress: () => setEditing(false) }]);

  return <View style={styles.root}>
    <Stack.Screen options={{
      title: editing ? (editId ? '编辑知识' : '新建知识') : '知识库',
      headerLeft: () => <Pressable accessibilityRole="button" accessibilityLabel={params.projectId ? params.returnTo === 'settings' ? '返回资料设置' : '返回白板' : '返回'} onPress={returnToWorkspace} style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4, paddingRight: 12, opacity: pressed ? 0.6 : 1 })}><AppIcon name="arrow-back" size={20} color={colors.inkMuted} /><Text style={{ color: colors.inkMuted, fontSize: 14 }}>{params.projectId ? params.returnTo === 'settings' ? '设置' : '白板' : '返回'}</Text></Pressable>,
      headerRight: () => editing ? <Pressable accessibilityRole="button" accessibilityLabel={origin === 'ai_adopted' ? '采用并保存' : '保存知识'} accessibilityState={{ disabled: busy || !title.trim() || !body.trim() }} disabled={busy || !title.trim() || !body.trim()} onPress={() => void save()} style={{ minHeight: 44, paddingHorizontal: 10, justifyContent: 'center', opacity: busy || !title.trim() || !body.trim() ? 0.4 : 1 }}><Text style={{ color: colors.ink, fontSize: 14, fontWeight: '600' }}>{busy ? '保存中' : origin === 'ai_adopted' ? '采用并保存' : '保存'}</Text></Pressable> : <View style={{ flexDirection: 'row' }}>
        <HeaderAction label={reading ? '编辑知识' : '新建知识'} icon={reading ? 'edit' : 'add'} disabled={Boolean(historical) || busy} onPress={() => edit(current)} />
        <HeaderAction label="知识库操作" icon="more-horiz" onPress={() => setToolsOpen(value => !value)} />
      </View>,
    }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      {error ? <Text accessibilityRole="alert" style={{ color: colors.coral, fontSize: 14, lineHeight: 22 }}>{error}</Text> : null}
      {editing ? <>
        <View style={styles.paper}>
          <View style={styles.segments}>{KNOWLEDGE_KINDS.map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: kind === value }} onPress={() => setKind(value)} style={[styles.segment, kind === value && styles.segmentSelected]}><Text style={[styles.segmentText, kind === value && styles.segmentTextSelected]}>{knowledgeKindLabel(value)}</Text></Pressable>)}</View>
          <TextInput accessibilityLabel="知识标题" placeholder="写一个清楚的标题" placeholderTextColor={colors.inkMuted} value={title} onChangeText={setTitle} maxLength={200} style={styles.titleInput} />
          <View style={styles.rule} />
          <TextInput accessibilityLabel="知识正文" placeholder={kind === 'material' ? '保留材料原文或摘录…' : '用自己的话，写下你的理解或经验…'} placeholderTextColor={colors.inkMuted} value={body} onChangeText={setBody} multiline textAlignVertical="top" style={styles.bodyInput} />
        </View>
        <QuietDisclosure title="出处与依据" meta={basis.length ? `${basis.length} 份材料` : '可选'}>
          <TextInput accessibilityLabel="知识出处" placeholder="出处或背景" placeholderTextColor={colors.inkMuted} value={source} onChangeText={setSource} multiline style={styles.sourceInput} />
          {kind !== 'material' ? library.entries.filter(row => row.kind === 'material' && !row.archived && row.id !== editId).map(row => <Pressable key={row.id} accessibilityRole="checkbox" accessibilityLabel={row.title} accessibilityState={{ checked: basis.includes(row.id) }} onPress={() => setBasis(values => values.includes(row.id) ? values.filter(id => id !== row.id) : [...values, row.id])} style={styles.basisRow}><AppIcon name={basis.includes(row.id) ? 'check-box' : 'check-box-outline-blank'} size={20} color={colors.inkMuted} /><Text style={{ flex: 1, color: colors.ink, fontSize: 14, lineHeight: 22 }}>{row.title}</Text></Pressable>) : null}
        </QuietDisclosure>
        {origin === 'ai_adopted' ? <Text style={styles.caption}>这段 AI 内容由你明确采用后保存。</Text> : null}
        <QuietAction label="取消修改" onPress={cancelEditing} />
      </> : reading ? <>
        <QuietAction label="返回列表" onPress={toList} />
        <View style={styles.paper}>
          <Text style={styles.eyebrow}>{knowledgeKindLabel(reading.kind)}{historical ? ' · 当时的引用版本' : current?.archived ? ' · 已归档' : ''}</Text>
          <Text selectable accessibilityRole="header" style={styles.readingTitle}>{reading.title}</Text>
          <Text style={styles.caption}>{formatUpdated(historical ? reading.created_at : current?.updated_at ?? reading.created_at)}{reading.authorship === 'ai_adopted' ? ' · AI 内容，已由你采用' : ''}</Text>
          <View style={styles.rule} />
          <MarkdownContent value={reading.body} scrollEnabled={false} contentPadding={0} backgroundColor={colors.surface} appearance="knowledge" />
        </View>
        {(reading.source || JSON.parse(reading.basis_json).length > 0) ? <QuietDisclosure key={reading.id} title="出处与依据" meta={JSON.parse(reading.basis_json).length ? `${JSON.parse(reading.basis_json).length} 份材料` : undefined}>
          {reading.source ? <Text selectable style={{ color: colors.inkMuted, fontSize: 14, lineHeight: 24 }}>{reading.source}</Text> : null}
          {(JSON.parse(reading.basis_json) as string[]).map(id => <QuietAction key={id} label={`查看依据：${library.entries.find(row => row.id === id)?.title ?? id}`} onPress={() => router.setParams({ entryId: id, revisionId: undefined })} />)}
        </QuietDisclosure> : null}
        {historical ? <QuietAction label="查看当前版本" onPress={() => router.setParams({ revisionId: undefined })} /> : current && params.projectId ? <Pressable accessibilityRole="button" accessibilityLabel={isBound ? '解除引用' : params.nodeId ? '引用到当前节点' : '引用到白板'} disabled={busy} accessibilityState={{ disabled: busy }} onPress={() => void act(() => bindKnowledgeEntry(db, params.projectId!, current.id, params.nodeId ?? null, !isBound))} style={({ pressed }) => ({ minHeight: 52, paddingHorizontal: 18, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii.medium, backgroundColor: colors.surface, opacity: busy ? 0.4 : pressed ? 0.65 : 1 })}>
          <AppIcon name={isBound ? 'link-off' : 'link'} size={20} color={colors.inkMuted} />
          <Text style={{ flex: 1, color: colors.ink, fontSize: 14 }}>{isBound ? '解除引用' : params.nodeId ? '引用到当前节点' : '引用到白板'}</Text>
          <Text style={styles.caption}>{policy === 'disabled' ? 'AI 引用未开启' : isBound ? '已指定' : '指定条目'}</Text>
        </Pressable> : null}
        {toolsOpen && current ? <View style={styles.tools}>
          {!historical ? <QuietAction disabled={busy} label={current.archived ? '恢复到列表' : '归档'} onPress={() => void act(() => archiveKnowledgeEntry(db, current.id, !current.archived, current.revision_id))} /> : null}
          {library.revisions.filter(row => row.entry_id === current.id && row.id !== current.revision_id).map(row => <QuietAction key={row.id} label={`旧版本 · ${row.created_at.slice(0, 16).replace('T', ' ')}`} onPress={() => router.setParams({ entryId: current.id, revisionId: row.id })} />)}
        </View> : null}
      </> : <>
        {params.projectId ? <KnowledgeReferenceOptions compact value={policy} boundCount={boundCount} disabled={busy} onChange={value => void act(() => setKnowledgePolicy(db, params.projectId!, value))} sourceRestricted={sourceRestricted} onOpenSourceSettings={() => router.push({ pathname: '/project-settings', params: { projectId: params.projectId!, showAiOptions: '1' } })} /> : null}
        {missingReference ? <Text style={{ color: colors.coral, fontSize: 14, lineHeight: 22 }}>这条知识或当时的版本尚未到齐。回答中的摘录仍保留，请同步完整知识库后再打开。</Text> : null}
        <View style={styles.search}><AppIcon name="search" size={20} color={colors.inkMuted} /><TextInput accessibilityLabel="搜索知识" placeholder="搜索知识" placeholderTextColor={colors.inkMuted} value={query} onChangeText={setQuery} style={{ flex: 1, minHeight: 44, color: colors.ink, fontSize: 15, paddingVertical: 10 }} />{query ? <HeaderAction label="清空搜索" icon="close" onPress={() => setQuery('')} /> : null}</View>
        <View style={styles.segments}>{[null, ...KNOWLEDGE_KINDS].map(value => <Pressable key={value ?? 'all'} accessibilityRole="tab" accessibilityLabel={value ? knowledgeKindLabel(value) : '全部知识'} accessibilityState={{ selected: filter === value }} onPress={() => setFilter(value)} style={[styles.segment, filter === value && styles.segmentSelected]}><Text style={[styles.segmentText, filter === value && styles.segmentTextSelected]}>{value === 'understanding' ? '理解' : value ? knowledgeKindLabel(value) : '全部'}</Text></Pressable>)}</View>
        {toolsOpen ? <View style={styles.tools}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 }}><Text style={{ color: colors.inkMuted, fontSize: 14 }}>查看已归档</Text><Switch accessibilityLabel="显示已归档知识" value={archived} onValueChange={setArchived} trackColor={{ false: colors.line, true: colors.lineStrong }} thumbColor={colors.surfaceStrong} /></View>
          <QuietAction label="导出知识库" disabled={busy} onPress={() => void act(async () => { const name = await exportKnowledgeFile(db); if (name) Alert.alert('已导出知识库', name); })} />
          <QuietAction label="导入知识副本" disabled={busy} onPress={() => void act(async () => { const incoming = await pickKnowledgeFile(); if (incoming) Alert.alert('导入知识副本', `将新增 ${incoming.entries.length} 条知识，保留已有内容。白板权限需要重新设置。`, [{ text: '取消', style: 'cancel' }, { text: '导入副本', onPress: () => void act(async () => { const count = await importKnowledgeFile(db, incoming); Alert.alert('导入完成', `已新增 ${count} 条知识副本。`); }) }]); })} />
        </View> : null}
        {archived ? <Text style={styles.caption}>正在查看已归档知识</Text> : null}
        {KNOWLEDGE_KINDS.filter(value => !filter || value === filter).map(value => {
          const entries = rows.filter(row => row.kind === value);
          return entries.length ? <View key={value} style={{ gap: 10 }}>
            <View style={styles.groupHeading}><Text accessibilityRole="header" style={styles.eyebrow}>{knowledgeKindLabel(value)}</Text><Text style={styles.caption}>{entries.length}</Text></View>
            {entries.map(row => <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={row.title} accessibilityHint="打开知识正文" onPress={() => { router.setParams({ entryId: row.id, revisionId: undefined }); setToolsOpen(false); }} style={({ pressed }) => ({ ...styles.entry, opacity: pressed ? 0.7 : 1 })}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}><Text numberOfLines={2} style={styles.entryTitle}>{row.title}</Text><AppIcon name="chevron-right" size={18} color={colors.inkMuted} /></View>
              <Text numberOfLines={2} style={styles.excerpt}>{excerpt(row.body)}</Text>
              <Text style={styles.caption}>{formatUpdated(row.updated_at)}{row.authorship === 'ai_adopted' ? ' · AI 已采用' : ''}</Text>
            </Pressable>)}
          </View> : null;
        })}
        {!rows.length ? <View style={{ paddingVertical: 40, alignItems: 'center', gap: 10 }}><AppIcon name="edit-note" size={28} color={colors.inkMuted} /><Text style={{ color: colors.ink, fontSize: 16 }}>{query ? '没有匹配的知识' : '写下你的第一个理解'}</Text><Text style={styles.caption}>{query ? '试试另一个关键词' : '点右上角的加号，从自己的话开始。'}</Text></View> : null}
        {!params.projectId && !query ? <Text style={[styles.caption, { lineHeight: 20 }]}>AI 引用由每块白板单独授权：白板菜单 → 白板资料与 AI 讲解。</Text> : null}
      </>}
    </ScrollView>
  </View>;
}

function HeaderAction({ label, icon, onPress, disabled = false }: { label: string; icon: Parameters<typeof AppIcon>[0]['name']; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center', opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}><AppIcon name={icon} size={21} color={colors.inkMuted} /></Pressable>;
}
function excerpt(value: string) {
  return value.replace(/^\s*#{1,6}\s+.*$/gmu, '').replace(/!\[[^\]]*\]\([^)]*\)/gu, '').replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/[`*_>#]/gu, '').replace(/\s+/gu, ' ').trim();
}
function formatUpdated(value: string) {
  const match = /^\d{4}-(\d{2})-(\d{2})/u.exec(value);
  return match ? `${Number(match[1])}月${Number(match[2])}日` : '';
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  page: { padding: 18, paddingBottom: 64, gap: 18 },
  paper: { backgroundColor: colors.surface, borderRadius: radii.large, padding: 20, gap: 16 },
  segments: { flexDirection: 'row', gap: 4, backgroundColor: colors.graySoft, borderRadius: radii.small, padding: 4 },
  segment: { flex: 1, minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 4, borderRadius: 9 },
  segmentSelected: { backgroundColor: colors.surfaceStrong },
  segmentText: { color: colors.inkMuted, fontSize: 13, textAlign: 'center' },
  segmentTextSelected: { color: colors.ink, fontWeight: '600' },
  titleInput: { color: colors.ink, fontSize: 24, fontWeight: '600', minHeight: 52, paddingVertical: 10 },
  bodyInput: { color: colors.ink, fontSize: 16, lineHeight: 28, minHeight: 300, paddingVertical: 4 },
  sourceInput: { color: colors.ink, fontSize: 14, lineHeight: 24, minHeight: 48, paddingVertical: 8 },
  basisRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 },
  readingTitle: { color: colors.ink, fontSize: 25, fontWeight: '600', lineHeight: 35 },
  rule: { height: 1, backgroundColor: colors.line },
  eyebrow: { color: colors.inkMuted, fontSize: 13, fontWeight: '500' },
  caption: { color: colors.inkMuted, fontSize: 12 },
  tools: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: radii.medium, backgroundColor: colors.surface },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, borderRadius: radii.medium, backgroundColor: colors.surface, minHeight: 48 },
  groupHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingTop: 8 },
  entry: { padding: 18, gap: 9, borderRadius: radii.medium, backgroundColor: colors.surface },
  entryTitle: { flex: 1, color: colors.ink, fontSize: 17, fontWeight: '600', lineHeight: 25 },
  excerpt: { color: colors.inkMuted, fontSize: 14, lineHeight: 22 },
});
