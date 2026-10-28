import { router, Stack } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { shareInbox } from '@/components/share-inbox';
import { WorkspaceButton, WorkspaceCard, WorkspaceField } from '@/components/workspace-controls';
import { getGraph, listProjects } from '@/data/knowledge-repository';
import { previewTextShare, type PendingTextShare, type SharedTextPreview } from '@/data/share-intake';
import { assertShareBatchTextBudget, discardPersistedSharedFiles, persistSharedFile, prepareSharedFileInput } from '@/data/shared-file-input';
import { buildSharedSourceInput } from '@/data/shared-source-input';
import { saveSharedSourceToNode, saveSharedSourcesToNode, type NewSourceItem } from '@/data/source-items';
import { colors } from '@/theme/tokens';
import type { KnowledgeNode, LearningProject } from '@/types/domain';

export default function ShareImportScreen() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const [pending, setPending] = useState<PendingTextShare | null>(() => shareInbox?.peekPendingShare() ?? null);
  const [projects, setProjects] = useState<LearningProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [nodes, setNodes] = useState<KnowledgeNode[]>([]);
  const [target, setTarget] = useState<'new' | 'existing'>('new');
  const [nodeId, setNodeId] = useState('');
  const [nodeQuery, setNodeQuery] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [staging, setStaging] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [retryExtraction, setRetryExtraction] = useState(0);
  const [prepared, setPrepared] = useState<{ id: string; inputs: NewSourceItem[] } | null>(null);
  const gate = useRef(false);

  const hasFiles = (pending?.fileCount ?? 0) > 0;
  const files = useMemo(() => pending?.files ?? [], [pending?.files]);
  let preview: SharedTextPreview | null = null;
  let previewError = '';
  if (pending) {
    if (pending.error) previewError = pending.error;
    else if (!hasFiles || pending.text.trim()) {
      try { preview = previewTextShare(hasFiles ? { ...pending, mimeType: 'text/plain' } : pending); }
      catch (cause) { previewError = cause instanceof Error ? cause.message : '无法读取分享内容'; }
    }
  }

  useEffect(() => {
    if (!pending || !hasFiles || pending.staged || pending.error || !shareInbox) return;
    let active = true;
    setStaging(true);
    void shareInbox.stageShareAsync(pending.id).then(result => {
      if (active) setPending(result);
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '文件暂存失败'); })
      .finally(() => { if (active) setStaging(false); });
    return () => { active = false; };
  }, [pending, hasFiles]);

  useEffect(() => {
    if (!pending || !hasFiles || !pending.staged || !files.length) return;
    let active = true;
    setExtracting(true);
    setPrepared(null);
    void Promise.all(files.map(file => prepareSharedFileInput('preview', file))).then(inputs => {
      assertShareBatchTextBudget(inputs);
      if (active) { setPrepared({ id: pending.id, inputs }); setError(''); }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '文件提取失败'); })
      .finally(() => { if (active) setExtracting(false); });
    return () => { active = false; };
  }, [pending, hasFiles, files, retryExtraction]);

  useEffect(() => {
    let active = true;
    void listProjects(db).then(items => {
      if (!active) return;
      setProjects(items);
      setProjectId(current => current && items.some(item => item.id === current) ? current : items[0]?.id ?? '');
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '白板列表读取失败'); });
    return () => { active = false; };
  }, [db]);

  useEffect(() => {
    if (!projectId) { setNodes([]); return; }
    let active = true;
    void getGraph(db, projectId).then(graph => {
      if (!active) return;
      setNodes(graph?.nodes ?? []);
      setNodeId(current => graph?.nodes.some(node => node.id === current) ? current : graph?.nodes[0]?.id ?? '');
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '节点列表读取失败'); });
    return () => { active = false; };
  }, [db, projectId]);

  useEffect(() => {
    if (!pending) { setTitle(''); return; }
    if ((pending.fileCount ?? 0) > 0) {
      setTitle(pending.subject || pending.files?.[0]?.name.replace(/\.[^.]+$/u, '') || '分享资料');
    } else {
      try { setTitle(previewTextShare(pending).title); }
      catch { setTitle(''); }
    }
  }, [pending]);

  async function finish() {
    if (pending && shareInbox && !await shareInbox.finishShareAsync(pending.id)) throw new Error('分享文件仍在处理中，请稍后重试');
    const next = shareInbox?.peekPendingShare() ?? null;
    setPending(next);
    setError('');
    if (!next) router.replace('/');
  }

  async function cancel() {
    if (gate.current || staging) return;
    gate.current = true;
    setBusy(true);
    try { await finish(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '关闭分享失败，请重试'); }
    finally { gate.current = false; setBusy(false); }
  }

  async function retryStage() {
    if (!pending || !shareInbox || staging || (pending.fileCount ?? 0) > 10) return;
    setStaging(true);
    setError('');
    try { setPending(await shareInbox.stageShareAsync(pending.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '文件暂存失败'); }
    finally { setStaging(false); }
  }

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      void cancel();
      return true;
    });
    return () => subscription.remove();
  });

  async function save() {
    if (gate.current || !pending || (!preview && !hasFiles) || !projectId || !title.trim() || staging || extracting
      || (hasFiles && (!pending.staged || prepared?.id !== pending.id)) || (target === 'existing' && !nodeId)) return;
    gate.current = true;
    setBusy(true);
    setError('');
    const copied: string[] = [];
    let committed = false;
    try {
      const destination = target === 'new' ? { kind: 'new' as const, title } : { kind: 'existing' as const, nodeId };
      let result: { nodeId: string };
      if (hasFiles) {
        const inputs = prepared!.inputs.map(input => ({ ...input, projectId }));
        if (preview) inputs.push(await buildSharedSourceInput(projectId, preview, `${title} · 分享文字`));
        assertShareBatchTextBudget(inputs);
        for (const [index, file] of files.entries()) {
          const uri = await persistSharedFile(projectId, file);
          copied.push(uri);
          inputs[index].assetUri = uri;
        }
        const saved = await saveSharedSourcesToNode(db, inputs, destination);
        committed = true;
        result = saved;
        const redundant = copied.filter((_, index) => saved.reused[index]);
        await discardPersistedSharedFiles(redundant).catch(() => {});
      } else {
        const input = await buildSharedSourceInput(projectId, preview!, title);
        result = await saveSharedSourceToNode(db, input, destination);
        committed = true;
      }
      if (!await shareInbox?.finishShareAsync(pending.id)) throw new Error('内容已保存，但分享入口未关闭；再次保存会复用这份资料');
      const next = shareInbox?.peekPendingShare() ?? null;
      if (next) { setPending(next); setError(''); }
      else router.replace({ pathname: '/project/[id]', params: { id: projectId, initialNodeId: result.nodeId } });
    } catch (cause) {
      if (!committed) await discardPersistedSharedFiles(copied).catch(() => {});
      setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally { gate.current = false; setBusy(false); }
  }

  const selectedProject = projects.find(item => item.id === projectId);
  return <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 18, paddingBottom: Math.max(40, insets.bottom + 24), gap: 16 }}>
    <Stack.Screen options={{ title: '接收分享', headerBackVisible: false, gestureEnabled: false }} />
    <Text style={{ color: colors.inkMuted, lineHeight: 22 }}>先看内容，再决定放到哪块白板。保存前不会上传或调用 AI。</Text>
    {!pending ? <WorkspaceCard><Text style={{ color: colors.ink }}>没有待处理的分享。</Text><WorkspaceButton label="返回白板" onPress={() => router.replace('/')} /></WorkspaceCard> : null}
    {previewError ? <WorkspaceCard><Text selectable style={{ color: colors.ink }}>{previewError}</Text>
      {hasFiles && (pending?.fileCount ?? 0) <= 10 && !staging ? <WorkspaceButton secondary label="重试读取文件" onPress={() => void retryStage()} /> : null}
      <WorkspaceButton secondary label={busy || staging ? '请稍候…' : '关闭这条分享'} disabled={busy || staging} onPress={() => void cancel()} />
    </WorkspaceCard> : null}
    {preview || hasFiles ? <>
      {preview ? <WorkspaceCard>
        <Text style={{ color: colors.inkMuted }}>{preview.kind === 'web' ? '网页链接' : preview.kind === 'markdown' ? 'Markdown 文字' : '分享文字'} · {preview.byteSize} 字节</Text>
        <Text selectable numberOfLines={12} style={{ color: colors.ink, lineHeight: 24 }}>{preview.text}</Text>
        {preview.sourceUrl ? <Text style={{ color: colors.inkMuted, lineHeight: 21 }}>只保存分享文字与链接；此时不会访问网页或提取全文。</Text> : null}
      </WorkspaceCard> : null}
      {hasFiles ? <WorkspaceCard>
        <Text style={{ color: colors.ink, fontWeight: '700' }}>{pending?.fileCount} 个分享文件</Text>
        {staging ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><ActivityIndicator color={colors.ink} /><Text style={{ color: colors.inkMuted }}>正在复制到应用临时空间…</Text></View> : null}
        {extracting ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><ActivityIndicator color={colors.ink} /><Text style={{ color: colors.inkMuted }}>正在本机提取预览…</Text></View> : null}
        {files.map((file, index) => <View key={`${file.sha256}:${index}`} style={{ gap: 8 }}>
          <Text style={{ color: colors.ink, fontWeight: '600' }}>{file.name} · {file.kind.toUpperCase()} · {Math.ceil(file.byteSize / 1024)} KiB</Text>
          {file.kind === 'image' ? <Image source={{ uri: file.uri }} style={{ width: '100%', height: 160, resizeMode: 'contain' }} accessibilityLabel={`${file.name} 图片预览`} /> : null}
          {prepared?.id === pending?.id ? <Text selectable numberOfLines={5} style={{ color: colors.inkMuted, lineHeight: 21 }}>{prepared?.inputs[index]?.segments.map(item => item.body).join('\n').slice(0, 360)}</Text> : null}
        </View>)}
        {hasFiles && !extracting && pending?.staged && !prepared && error ? <WorkspaceButton secondary label="重试提取预览" onPress={() => { setError(''); setRetryExtraction(value => value + 1); }} /> : null}
        <Text style={{ color: colors.inkMuted, lineHeight: 21 }}>全部文件提取成功后才可保存；单文件不超过同步附件上限 32 MiB，整批失败不会创建节点。</Text>
      </WorkspaceCard> : null}
      <WorkspaceField label={hasFiles ? '节点标题' : '资料标题'} value={title} onChangeText={setTitle} />
      <Text style={{ color: colors.ink, fontWeight: '700' }}>选择白板</Text>
      {projects.length === 0 ? <Text style={{ color: colors.inkMuted }}>还没有可用白板。可以先关闭分享，在应用内创建白板后重新分享。</Text> : null}
      {projects.map(project => <Choice key={project.id} selected={project.id === projectId} label={project.title} onPress={() => { setProjectId(project.id); setNodes([]); setNodeId(''); setNodeQuery(''); setTarget('new'); }} />)}
      {selectedProject ? <>
        <Text style={{ color: colors.ink, fontWeight: '700' }}>保存位置 · {selectedProject.title}</Text>
        <Choice selected={target === 'new'} label="新建节点并挂载资料" onPress={() => setTarget('new')} />
        <Choice selected={target === 'existing'} label="挂载到已有节点" onPress={() => setTarget('existing')} />
        {target === 'existing' ? <>
          <WorkspaceField label="查找已有节点" value={nodeQuery} onChangeText={setNodeQuery} />
          {nodes.filter(node => node.title.toLocaleLowerCase().includes(nodeQuery.trim().toLocaleLowerCase())).slice(0, 30)
            .map(node => <Choice key={node.id} selected={node.id === nodeId} label={node.title} onPress={() => setNodeId(node.id)} />)}
          {nodes.length > 30 && !nodeQuery.trim() ? <Text style={{ color: colors.inkMuted }}>先显示前 30 个节点，可输入名称查找更多。</Text> : null}
        </> : null}
      </> : null}
      {error ? <Text selectable style={{ color: colors.coral }}>{error}</Text> : null}
      <WorkspaceButton label={busy ? '正在保存…' : target === 'new' ? '保存并新建节点' : '挂载资料'} disabled={busy || staging || extracting || Boolean(previewError) || (hasFiles && prepared?.id !== pending?.id) || !projectId || !title.trim() || (target === 'existing' && !nodeId)} onPress={() => void save()} />
      <WorkspaceButton secondary label="取消这条分享" disabled={busy || staging} onPress={() => void cancel()} />
    </> : null}
  </ScrollView>;
}

function Choice({ selected, label, onPress }: { selected: boolean; label: string; onPress: () => void }) {
  return <Pressable accessibilityRole="radio" accessibilityState={{ selected }} onPress={onPress} style={{ padding: 14, minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: selected ? colors.blue : colors.line, backgroundColor: selected ? colors.graySoft : colors.surfaceStrong }}>
    <Text style={{ color: colors.ink, fontWeight: selected ? '700' : '400' }}>{selected ? '✓  ' : ''}{label}</Text>
  </Pressable>;
}
