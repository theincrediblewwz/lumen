import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MarkdownContent } from '@/components/markdown-content';
import { WorkspaceButton, WorkspaceCard } from '@/components/workspace-controls';
import {
  currentReviewSourceChanged, finishBranchReview, getReviewSession, recordBranchReview,
  revealReviewReference, saveReviewDraft, startBranchReview, type ReviewSession,
} from '@/data/branch-review';
import type { ReviewRating } from '@/data/review-plan';
import { getDocument } from '@/data/knowledge-repository';
import { colors } from '@/theme/tokens';

export default function BranchReviewScreen() {
  const { projectId, rootNodeId } = useLocalSearchParams<{ projectId: string; rootNodeId: string }>();
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');
  const [sourceChanged, setSourceChanged] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const revision = useRef(0);
  const gate = useRef(false);
  const card = session?.cards[session.position] ?? null;

  const load = useCallback(async (includeUpcoming = false) => {
    if (!projectId || !rootNodeId) throw new Error('复习入口缺少白板或节点');
    const next = await startBranchReview(db, projectId, rootNodeId, includeUpcoming);
    setSession(next);
    setAnswer(next?.answerDraft ?? '');
    revision.current = next?.draftRevision ?? 0;
    return next;
  }, [db, projectId, rootNodeId]);

  useEffect(() => {
    let active = true;
    void load().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '无法开始复习'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load]);

  useEffect(() => {
    if (!card) { setSourceChanged(false); return; }
    let active = true;
    void currentReviewSourceChanged(db, card).then(value => { if (active) setSourceChanged(value); })
      .catch(() => { if (active) setSourceChanged(true); });
    return () => { active = false; };
  }, [db, card]);

  function changeAnswer(value: string) {
    if (!session || !card || session.revealed) return;
    setAnswer(value);
    const nextRevision = ++revision.current;
    void saveReviewDraft(db, session.id, session.position, nextRevision, value)
      .catch(cause => setError(cause instanceof Error ? cause.message : '草稿暂存失败'));
  }

  async function reveal() {
    if (!session || gate.current) return;
    gate.current = true; setBusy(true); setError('');
    try {
      if (!await revealReviewReference(db, session.id, session.position, answer)) throw new Error('复习进度已变化，请重新打开');
      setSession({ ...session, answerDraft: answer.trim(), revealed: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法揭示参考'); }
    finally { gate.current = false; setBusy(false); }
  }

  async function rate(rating: ReviewRating) {
    if (!session || gate.current) return;
    gate.current = true; setBusy(true); setError('');
    try {
      const outcome = await recordBranchReview(db, session.id, session.position, rating);
      const next = await getReviewSession(db, session.projectId, session.rootNodeId);
      setSession(next);
      setAnswer(next?.answerDraft ?? '');
      revision.current = next?.draftRevision ?? 0;
      setMessage(`已记录${rating === 'deferred' ? '暂缓' : '自评'}；建议下次回顾：${new Date(outcome.dueAt).toLocaleString()}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法保存复习'); }
    finally { gate.current = false; setBusy(false); }
  }

  async function beginEarly() {
    if (gate.current) return;
    gate.current = true; setBusy(true); setError('');
    try { await load(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '无法开始提前复习'); }
    finally { gate.current = false; setBusy(false); }
  }

  async function complete() {
    if (session) await finishBranchReview(db, session.id);
    router.back();
  }

  async function openCurrentSource(documentId: string) {
    try {
      const document = await getDocument(db, documentId);
      if (!document || document.projectId !== projectId) throw new Error('当前原文已移除；本轮参考快照仍保留在复习记录中');
      router.push({ pathname: '/document/[id]', params: { id: documentId } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法打开原文'); }
  }

  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 18, paddingBottom: 32 + insets.bottom, gap: 14 }}>
    <Stack.Screen options={{ title: '回顾这一支' }} />
    <Text style={{ color: colors.inkMuted, lineHeight: 21 }}>先回答，再看原文。每轮最多 5 题；自评只安排下次回顾。</Text>
    {loading ? <ActivityIndicator color={colors.ink} /> : null}
    {error ? <WorkspaceCard><Text selectable style={{ color: colors.coral }}>{error}</Text></WorkspaceCard> : null}
    {message ? <Text style={{ color: colors.inkMuted, lineHeight: 21 }}>{message}</Text> : null}
    {!loading && !session && !error ? <WorkspaceCard>
      <Text style={{ color: colors.ink, lineHeight: 23 }}>这一支目前没有到期的题目。</Text>
      <WorkspaceButton label="现在也回顾" onPress={() => void beginEarly()} disabled={busy} />
      <WorkspaceButton secondary label="返回白板" onPress={() => router.back()} />
    </WorkspaceCard> : null}
    {session && !card ? <WorkspaceCard>
      <Text style={{ color: colors.ink, fontSize: 19, fontWeight: '700' }}>这一轮已完成</Text>
      <Text style={{ color: colors.inkMuted }}>回答和自评已保留。下次打开会按到期时间重新选题。</Text>
      <WorkspaceButton label="完成并返回白板" onPress={() => void complete()} disabled={busy} />
    </WorkspaceCard> : null}
    {session && card ? <>
      <Text style={{ color: colors.inkMuted }}>第 {session.position + 1} / {session.cards.length} 题 · {card.nodeTitle}</Text>
      <WorkspaceCard>
        <Text style={{ color: colors.blue, fontWeight: '700' }}>先回答</Text>
        <MarkdownContent value={card.question} contentPadding={0} backgroundColor={colors.surfaceStrong} scrollEnabled={false} />
      </WorkspaceCard>
      <TextInput accessibilityLabel="我的回答" value={answer} onChangeText={changeAnswer} editable={!session.revealed && !busy}
        multiline textAlignVertical="top" placeholder="用自己的话解释，最好举一个例子…" placeholderTextColor={colors.gray}
        style={{ minHeight: 165, borderRadius: 18, padding: 16, backgroundColor: colors.surfaceStrong, color: colors.ink, fontSize: 16, lineHeight: 24 }} />
      {sourceChanged ? <Text style={{ color: colors.amber, lineHeight: 21 }}>原文已变更或移除；下方参考保留的是本轮开始时的快照。</Text> : null}
      {!session.revealed ? <>
        <WorkspaceButton label="写完了，显示参考" onPress={() => void reveal()} disabled={busy || !answer.trim()} />
        <WorkspaceButton secondary label="暂缓这题 · 明天再看" onPress={() => void rate('deferred')} disabled={busy} />
      </> : <>
        <WorkspaceCard>
          <Text style={{ color: colors.amber, fontWeight: '700' }}>保存的文档参考（未经外部事实核验）</Text>
          <MarkdownContent value={card.reference} contentPadding={0} backgroundColor={colors.surfaceStrong} scrollEnabled={false} />
          <WorkspaceButton secondary label="打开当前原文" onPress={() => void openCurrentSource(card.documentId)} />
        </WorkspaceCard>
        <Text style={{ color: colors.inkMuted }}>对照自己的回答后选择：</Text>
        <View style={{ gap: 9 }}>
          <WorkspaceButton label="记得" onPress={() => void rate('remembered')} disabled={busy} />
          <WorkspaceButton secondary label="模糊" onPress={() => void rate('fuzzy')} disabled={busy} />
          <WorkspaceButton secondary label="忘了" onPress={() => void rate('forgotten')} disabled={busy} />
        </View>
      </>}
      <WorkspaceButton secondary label="稍后继续 · 保留进度" onPress={() => router.back()} disabled={busy} />
    </> : null}
  </ScrollView>;
}
