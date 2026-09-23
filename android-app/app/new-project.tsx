import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { prepareInitialExpansion } from '@/ai/initial-expansion-intent';
import { createProject } from '@/data/knowledge-repository';
import { colors, radii } from '@/theme/tokens';
import type { DetailLevel, ProjectMode } from '@/types/domain';

export default function NewProjectScreen() {
  const { topicId } = useLocalSearchParams<{ topicId?: string }>();
  const db = useSQLiteContext();
  const [title, setTitle] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [mode, setMode] = useState<ProjectMode>('learning');
  const [detailLevel, setDetailLevel] = useState<DetailLevel>('detailed');
  const [saving, setSaving] = useState(false);
  const canSubmit = Boolean(title.trim()) && (mode === 'learning' || Boolean(sourceText.trim()));

  const submit = async () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    let created: Awaited<ReturnType<typeof createProject>>;
    try {
      created = await createProject(db, title, sourceText, topicId ?? null, {
        mode,
        explanationStyle: 'plain_language',
        detailLevel,
        allowOutsideKnowledge: mode === 'learning',
      });
    } catch (error) {
      Alert.alert('目标没有创建完成', error instanceof Error ? error.message : '请稍后重试');
      setSaving(false);
      return;
    }
    try {
      await prepareInitialExpansion(created.projectId);
    } catch {
      router.replace({ pathname: '/project/[id]', params: { id: created.projectId, initialNodeId: created.rootNodeId } });
      Alert.alert('目标已创建', '首次自动分析没有排队，但目标没有丢失。请在图上点击“生成第一层”。');
      return;
    }
    router.replace({ pathname: '/project/[id]', params: { id: created.projectId, initialNodeId: created.rootNodeId } });
  };

  return (
    <KeyboardAvoidingView behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 22 }}
      >
        <View style={{ gap: 8 }}>
          <Text selectable style={{ color: colors.ink, fontSize: 25, fontWeight: '800' }}>
            {mode === 'learning' ? '你现在想真正弄懂什么？' : '你现在想整理什么资料？'}
          </Text>
          <Text selectable style={{ color: colors.inkMuted, fontSize: 14.5, lineHeight: 22 }}>
            先给出目标。资料可以只贴一段，之后还可以继续补充。
          </Text>
        </View>

        <View style={{ gap: 9 }}>
          <Text style={{ color: colors.ink, fontSize: 13, fontWeight: '700' }}>图谱模式</Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <ChoiceCard
              selected={mode === 'learning'}
              title="学习图"
              description="追溯前置、讲明白并继续探索"
              onPress={() => setMode('learning')}
            />
            <ChoiceCard
              selected={mode === 'summary'}
              title="总结图"
              description="忠实整理资料的结构与证据"
              onPress={() => setMode('summary')}
            />
          </View>
        </View>

        <View style={{ gap: 9 }}>
          <Text style={{ color: colors.ink, fontSize: 13, fontWeight: '700' }}>
            {mode === 'learning' ? '学习目标' : '总结主题'}
          </Text>
          <TextInput
            autoFocus
            value={title}
            onChangeText={setTitle}
            placeholder={mode === 'learning' ? '例如：理解扩散模型为什么能生成图像' : '例如：总结这篇论文的核心论证'}
            placeholderTextColor={colors.gray}
            style={{
              minHeight: 56,
              paddingHorizontal: 16,
              borderRadius: radii.medium,
              borderCurve: 'continuous',
              backgroundColor: colors.surfaceStrong,
              color: colors.ink,
              fontSize: 16,
            }}
          />
        </View>

        <View style={{ gap: 9 }}>
          <Text style={{ color: colors.ink, fontSize: 13, fontWeight: '700' }}>
            {mode === 'learning' ? '资料或现有理解（可选）' : '要总结的文字资料'}
          </Text>
          <TextInput
            value={sourceText}
            onChangeText={setSourceText}
            placeholder={mode === 'learning'
              ? '粘贴一段资料、论文摘要，或者写下自己目前卡住的地方……'
              : '先粘贴资料；创建后还可以继续加入 Markdown、PDF、图片或网页……'}
            placeholderTextColor={colors.gray}
            multiline
            textAlignVertical="top"
            style={{
              minHeight: 190,
              padding: 16,
              borderRadius: radii.large,
              borderCurve: 'continuous',
              backgroundColor: colors.surfaceStrong,
              color: colors.ink,
              fontSize: 15,
              lineHeight: 23,
            }}
          />
        </View>

        <View style={{ gap: 9 }}>
          <Text style={{ color: colors.ink, fontSize: 13, fontWeight: '700' }}>讲解详细程度</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {([
              ['one_sentence', '一句话'],
              ['concise', '简短'],
              ['detailed', '详细'],
              ['deep', '深入'],
            ] as const).map(([value, label]) => (
              <Pressable
                key={value}
                onPress={() => setDetailLevel(value)}
                style={({ pressed }) => ({
                  minHeight: 40,
                  paddingHorizontal: 15,
                  borderRadius: 20,
                  borderCurve: 'continuous',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: detailLevel === value ? colors.ink : colors.surfaceStrong,
                  opacity: pressed ? 0.72 : 1,
                })}
              >
                <Text style={{ color: detailLevel === value ? colors.white : colors.ink, fontSize: 13, fontWeight: '700' }}>{label}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <Pressable
          accessibilityRole="button"
          disabled={!canSubmit || saving}
          onPress={submit}
          style={({ pressed }) => ({
            minHeight: 56,
            borderRadius: 28,
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'row',
            gap: 9,
            backgroundColor: colors.ink,
            opacity: !canSubmit || saving ? 0.42 : pressed ? 0.82 : 1,
          })}
        >
          {saving ? <ActivityIndicator color={colors.white} /> : null}
          <Text style={{ color: colors.white, fontSize: 16, fontWeight: '800' }}>
            {saving ? '正在创建并准备分析…' : mode === 'learning' ? '创建，并让 AI 分析第一层' : '创建，并让 AI 整理第一层'}
          </Text>
        </Pressable>

        <Text selectable style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19, textAlign: 'center' }}>
          创建后会用你已配置的 AI 分析目标并生成第一层关键学习点。若尚未配置或本次失败，目标仍会保留，你可以在图上手动重试。
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ChoiceCard({
  selected,
  title,
  description,
  onPress,
}: {
  selected: boolean;
  title: string;
  description: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 92,
        padding: 15,
        gap: 6,
        borderRadius: radii.medium,
        borderCurve: 'continuous',
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? colors.ink : colors.line,
        backgroundColor: selected ? colors.graySoft : colors.surfaceStrong,
        opacity: pressed ? 0.72 : 1,
      })}
    >
      <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '800' }}>{title}</Text>
      <Text style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 18 }}>{description}</Text>
    </Pressable>
  );
}

