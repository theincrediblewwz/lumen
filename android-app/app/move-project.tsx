import { useCallback, useEffect, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';

import { getGraph } from '@/data/knowledge-repository';
import { listAllTopics, moveProjectToTopic } from '@/data/personal-context';
import { colors, radii } from '@/theme/tokens';
import type { Topic } from '@/types/domain';

export default function MoveProjectScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const db = useSQLiteContext();
  const [topics, setTopics] = useState<Topic[]>([]);
  const [currentTopicId, setCurrentTopicId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [movingTo, setMovingTo] = useState<string | null | undefined>(undefined);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [graph, allTopics] = await Promise.all([getGraph(db, projectId), listAllTopics(db)]);
      if (!graph) throw new Error('学习图谱不存在');
      setCurrentTopicId(graph.project.topicId);
      setTopics(allTopics);
    } catch (error) {
      Alert.alert('无法读取专题', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setLoading(false);
    }
  }, [db, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => flattenTopics(topics), [topics]);

  const move = async (topicId: string | null) => {
    if (!projectId || topicId === currentTopicId || movingTo !== undefined) return;
    setMovingTo(topicId);
    try {
      await moveProjectToTopic(db, projectId, topicId);
      router.back();
    } catch (error) {
      Alert.alert('没有移动完成', error instanceof Error ? error.message : '请稍后重试');
      setMovingTo(undefined);
    }
  };

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas }}>
        <ActivityIndicator color={colors.ink} />
      </View>
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, gap: 12 }}
      style={{ backgroundColor: colors.canvas }}
    >
      <Text selectable style={{ color: colors.ink, fontSize: 24, fontWeight: '800', marginBottom: 4 }}>
        移动学习图谱
      </Text>
      <Text selectable style={{ color: colors.inkMuted, lineHeight: 21, marginBottom: 8 }}>
        只改变它在首页里的位置，不会改动图谱、回答、收藏或 AI 上下文。
      </Text>
      <TopicRow
        title="全部图谱"
        subtitle="不放进任何专题"
        selected={currentTopicId === null}
        moving={movingTo === null}
        onPress={() => void move(null)}
      />
      {rows.map(({ topic, depth }) => (
        <View key={topic.id} style={{ marginLeft: Math.min(depth, 4) * 18 }}>
          <TopicRow
            title={topic.title}
            subtitle={depth ? `第 ${depth + 1} 层专题` : '顶层专题'}
            selected={currentTopicId === topic.id}
            moving={movingTo === topic.id}
            onPress={() => void move(topic.id)}
          />
        </View>
      ))}
    </ScrollView>
  );
}

function TopicRow({
  title,
  subtitle,
  selected,
  moving,
  onPress,
}: {
  title: string;
  subtitle: string;
  selected: boolean;
  moving: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: selected }}
      disabled={selected || moving}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 70,
        borderRadius: radii.medium,
        borderCurve: 'continuous',
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? colors.blue : colors.line,
        backgroundColor: colors.surfaceStrong,
        paddingHorizontal: 17,
        paddingVertical: 13,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        opacity: pressed ? 0.76 : 1,
      })}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '800' }}>{title}</Text>
        <Text style={{ color: colors.inkMuted, fontSize: 12 }}>{selected ? '当前位置' : subtitle}</Text>
      </View>
      {moving ? <ActivityIndicator color={colors.blue} /> : (
        <Text style={{ color: selected ? colors.blue : colors.inkMuted, fontWeight: '800' }}>
          {selected ? '已选' : '移动'}
        </Text>
      )}
    </Pressable>
  );
}

function flattenTopics(topics: Topic[]) {
  const children = new Map<string | null, Topic[]>();
  for (const topic of topics) {
    const siblings = children.get(topic.parentId) ?? [];
    siblings.push(topic);
    children.set(topic.parentId, siblings);
  }
  const rows: { topic: Topic; depth: number }[] = [];
  const visited = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    for (const topic of children.get(parentId) ?? []) {
      if (visited.has(topic.id)) continue;
      visited.add(topic.id);
      rows.push({ topic, depth });
      visit(topic.id, depth + 1);
    }
  };
  visit(null, 0);
  for (const topic of topics) {
    if (!visited.has(topic.id)) rows.push({ topic, depth: 0 });
  }
  return rows;
}
