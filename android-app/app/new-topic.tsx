import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput } from 'react-native';

import { createTopic } from '@/data/personal-context';
import { colors, radii } from '@/theme/tokens';

export default function NewTopicScreen() {
  const { parentId } = useLocalSearchParams<{ parentId?: string }>();
  const db = useSQLiteContext();
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      const id = await createTopic(db, title, parentId ?? null);
      router.replace({ pathname: '/', params: { topicId: id } });
    } catch (error) {
      Alert.alert('专题没有创建完成', error instanceof Error ? error.message : '请稍后重试');
      setSaving(false);
    }
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 20, gap: 20 }}
      style={{ backgroundColor: colors.canvas }}
    >
      <Text selectable style={{ color: colors.ink, fontSize: 24, fontWeight: '800' }}>
        建立一个专题空间
      </Text>
      <Text selectable style={{ color: colors.inkMuted, fontSize: 14, lineHeight: 22 }}>
        专题可以继续包含子专题和学习图谱。“AI 对你的了解”也可以在这一层单独设置。
      </Text>
      <TextInput
        autoFocus
        value={title}
        onChangeText={setTitle}
        placeholder="例如：机器学习、唐代史、论文阅读"
        placeholderTextColor={colors.gray}
        returnKeyType="done"
        onSubmitEditing={submit}
        style={{
          minHeight: 58,
          paddingHorizontal: 17,
          borderRadius: radii.medium,
          borderCurve: 'continuous',
          backgroundColor: colors.surfaceStrong,
          color: colors.ink,
          fontSize: 16,
        }}
      />
      <Pressable
        accessibilityRole="button"
        disabled={!title.trim() || saving}
        onPress={submit}
        style={({ pressed }) => ({
          minHeight: 56,
          borderRadius: 28,
          backgroundColor: colors.ink,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: 8,
          opacity: !title.trim() || saving ? 0.42 : pressed ? 0.82 : 1,
        })}
      >
        {saving ? <ActivityIndicator color={colors.white} /> : null}
        <Text style={{ color: colors.white, fontSize: 15, fontWeight: '800' }}>
          {saving ? '正在创建…' : '创建专题'}
        </Text>
      </Pressable>
    </ScrollView>
  );
}
