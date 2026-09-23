import { useCallback, useState } from 'react';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';

import { AppIcon } from '@/components/app-icon';
import { listNodeAnswers, setNodeAnswerSaved } from '@/data/node-answers';
import { colors, floatingShadow, radii } from '@/theme/tokens';
import type { NodeAnswer } from '@/types/domain';

export default function NodeAnswersScreen() {
  const { nodeId, title } = useLocalSearchParams<{ nodeId: string; title?: string }>();
  const db = useSQLiteContext();
  const [answers, setAnswers] = useState<NodeAnswer[]>([]);
  const load = useCallback(async () => {
    if (nodeId) setAnswers(await listNodeAnswers(db, nodeId));
  }, [db, nodeId]);
  useFocusEffect(useCallback(() => { load().catch(() => undefined); }, [load]));

  const toggle = async (answer: NodeAnswer) => {
    try {
      await setNodeAnswerSaved(db, answer.id, !answer.saved);
      await load();
    } catch (error) {
      Alert.alert('无法保存回答', error instanceof Error ? error.message : '请稍后重试');
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 18, paddingBottom: 48, gap: 14 }}>
      <Stack.Screen options={{ title: title ? `回答 · ${title}` : '回答记录' }} />
      <Text selectable style={{ color: colors.inkMuted, fontSize: 13, lineHeight: 20 }}>
        每次成功展开都会留下问题和回答快照。点“收藏”后，它会进入便携导出。
      </Text>
      {answers.map((answer) => (
        <View key={answer.id} style={{ padding: 16, borderRadius: radii.large, borderCurve: 'continuous', backgroundColor: colors.surfaceStrong, boxShadow: floatingShadow, gap: 11 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text selectable style={{ color: colors.ink, fontSize: 14.5, lineHeight: 21, fontWeight: '800' }}>{answer.question}</Text>
              <Text style={{ color: colors.inkMuted, fontSize: 11.5 }}>{sourceLabel(answer)} · {new Date(answer.createdAt).toLocaleString()}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: answer.saved }}
              onPress={() => toggle(answer)}
              style={({ pressed }) => ({ minWidth: 78, height: 36, borderRadius: 18, borderCurve: 'continuous', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, backgroundColor: answer.saved ? colors.amberSoft : colors.canvas, opacity: pressed ? 0.72 : 1 })}
            >
              <AppIcon name={answer.saved ? 'bookmark' : 'bookmark-outline'} color={answer.saved ? colors.amber : colors.inkMuted} size={17} />
              <Text style={{ color: answer.saved ? colors.ink : colors.inkMuted, fontSize: 11.5, fontWeight: '800' }}>{answer.saved ? '已收藏' : '收藏'}</Text>
            </Pressable>
          </View>
          <View style={{ height: 1, backgroundColor: colors.line }} />
          <Text selectable numberOfLines={5} style={{ color: colors.ink, fontSize: 13, lineHeight: 21 }}>{plainPreview(answer.body)}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/answer/[id]', params: { id: answer.id } })}
            style={({ pressed }) => ({ alignSelf: 'flex-start', minHeight: 38, borderRadius: 19, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blueSoft, opacity: pressed ? 0.72 : 1 })}
          >
            <Text style={{ color: colors.ink, fontSize: 12.5, fontWeight: '800' }}>阅读排版后的完整回答</Text>
          </Pressable>
        </View>
      ))}
      {!answers.length ? <Text style={{ color: colors.inkMuted, fontSize: 13 }}>这个节点还没有回答记录。提出问题并成功展开后会显示在这里。</Text> : null}
    </ScrollView>
  );
}

function plainPreview(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/gu, ' [代码] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' [图片] ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^[#>*+-]+\s*/gmu, '')
    .replace(/[*_`~]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function sourceLabel(answer: NodeAnswer) {
  if (answer.adapter === 'byok') return answer.actualModel ? `个人 AI · ${answer.actualModel}` : '个人 AI';
  if (answer.adapter === 'gateway') return 'AI Gateway';
  if (answer.adapter === 'imported') return '导入回答';
  return '本地模拟结果';
}
