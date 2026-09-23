import { useEffect, useState } from 'react';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/app-icon';
import { MarkdownContent } from '@/components/markdown-content';
import { WorkspaceButton } from '@/components/workspace-controls';
import { getNodeAnswer, setNodeAnswerSaved } from '@/data/node-answers';
import { appendSourceCitations, listSourceCitationsForTarget } from '@/data/source-citations';
import { colors } from '@/theme/tokens';
import type { NodeAnswer, SourceCitation } from '@/types/domain';

export default function AnswerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useSQLiteContext();
  const [answer, setAnswer] = useState<NodeAnswer | null>(null);
  const [citations, setCitations] = useState<SourceCitation[]>([]);
  useEffect(() => {
    if (!id) return;
    Promise.all([
      getNodeAnswer(db, id),
      listSourceCitationsForTarget(db, 'answer', id),
    ]).then(([value, sourceCitations]) => {
      setAnswer(value);
      setCitations(sourceCitations);
    });
  }, [db, id]);

  if (!answer) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas }}><ActivityIndicator color={colors.ink} /></View>;

  const toggleSaved = async () => {
    await setNodeAnswerSaved(db, answer.id, !answer.saved);
    setAnswer({ ...answer, saved: !answer.saved });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <Stack.Screen
        options={{
          title: '完整回答',
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 17 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="回到回答所在节点"
                onPress={() => router.push({
                  pathname: '/project/[id]',
                  params: { id: answer.projectId, initialNodeId: answer.nodeId, favoriteJump: '1' },
                })}
                hitSlop={10}
              >
                <AppIcon name="my-location" color={colors.ink} size={21} />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={answer.saved ? '取消收藏' : '收藏回答'} onPress={toggleSaved} hitSlop={10}>
                <AppIcon name={answer.saved ? 'bookmark' : 'bookmark-outline'} color={answer.saved ? colors.amber : colors.ink} size={22} />
              </Pressable>
            </View>
          ),
        }}
      />
      <View style={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 2, gap: 4 }}>
        <Text selectable style={{ color: colors.ink, fontSize: 15, fontWeight: '800', lineHeight: 22 }}>{answer.question}</Text>
        <Text style={{ color: colors.inkMuted, fontSize: 11.5 }}>{sourceLabel(answer)} · {new Date(answer.createdAt).toLocaleString()}</Text>
        <WorkspaceButton label="保存文档并新建节点" secondary onPress={() => router.push({ pathname: '/capture-discussion', params: { answerId: answer.id } })} />
      </View>
      <MarkdownContent value={appendSourceCitations(answer.body, citations)} />
    </View>
  );
}

function sourceLabel(answer: NodeAnswer) {
  if (answer.adapter === 'byok') return answer.actualModel ? `个人 AI · ${answer.actualModel}` : '个人 AI';
  if (answer.adapter === 'gateway') return 'AI Gateway';
  if (answer.adapter === 'imported') return '导入回答';
  return '本地模拟结果';
}
