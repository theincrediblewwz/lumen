import { useCallback, useMemo, useState } from 'react';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/app-icon';
import {
  deleteUnderstandingDocument,
  listProjectUnderstandingScopes,
  listUnderstandingDocuments,
  saveUnderstandingDocument,
  setProjectUnderstandingScopeEnabled,
} from '@/data/personal-context';
import { colors, floatingShadow, radii } from '@/theme/tokens';
import type {
  AiUnderstandingDocument,
  ProjectUnderstandingScope,
  UnderstandingCategory,
  UnderstandingScopeType,
} from '@/types/domain';

const categoryOptions: {
  id: UnderstandingCategory;
  label: string;
  description: string;
  color: string;
}[] = [
  {
    id: 'preference',
    label: '讲解偏好',
    description: '例如“先说人话，再给公式”“多用最小例子”。它只调整表达，不改变事实。',
    color: colors.blue,
  },
  {
    id: 'known',
    label: '我确认知道',
    description: '你明确告诉 AI 已经熟悉的知识；这属于自述，不冒充事实核验。',
    color: colors.green,
  },
  {
    id: 'pending',
    label: '待验证理解',
    description: 'AI 或你怀疑已经会、但还需要诊断确认的内容，不能直接当作已掌握。',
    color: colors.amber,
  },
];

export default function AiUnderstandingScreen() {
  const params = useLocalSearchParams<{
    scopeType?: UnderstandingScopeType;
    scopeId?: string;
    title?: string;
    projectId?: string;
  }>();
  const scopeType: UnderstandingScopeType = params.scopeType ?? 'global';
  const scopeId = params.scopeId ?? 'global';
  const title = params.title ?? (scopeType === 'global' ? '全局' : '当前层级');
  const projectId = params.projectId;
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const [documents, setDocuments] = useState<AiUnderstandingDocument[]>([]);
  const [scopes, setScopes] = useState<ProjectUnderstandingScope[]>([]);
  const [editor, setEditor] = useState<AiUnderstandingDocument | 'new' | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [draftCategory, setDraftCategory] = useState<UnderstandingCategory>('preference');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const [items, inherited] = await Promise.all([
      listUnderstandingDocuments(db, scopeType, scopeId),
      projectId ? listProjectUnderstandingScopes(db, projectId) : Promise.resolve([]),
    ]);
    setDocuments(items);
    setScopes(inherited);
  }, [db, projectId, scopeId, scopeType]);

  useFocusEffect(useCallback(() => {
    void refresh();
  }, [refresh]));

  const grouped = useMemo(() => categoryOptions.map((category) => ({
    ...category,
    documents: documents.filter((item) => item.category === category.id),
  })), [documents]);

  const openEditor = (item: AiUnderstandingDocument | 'new', category?: UnderstandingCategory) => {
    setEditor(item);
    setDraftTitle(item === 'new' ? '' : item.title);
    setDraftBody(item === 'new' ? '' : item.body);
    setDraftCategory(item === 'new' ? category ?? 'preference' : item.category);
  };

  const save = async () => {
    if (!draftTitle.trim() || !draftBody.trim() || saving) return;
    setSaving(true);
    try {
      await saveUnderstandingDocument(db, {
        id: editor && editor !== 'new' ? editor.id : undefined,
        scopeType,
        scopeId,
        category: draftCategory,
        title: draftTitle,
        body: draftBody,
      });
      setEditor(null);
      await refresh();
    } catch (error) {
      Alert.alert('没有保存完成', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  const remove = (item: AiUnderstandingDocument) => {
    Alert.alert('删除这条内容？', '只会删除当前层的这一条，不影响其他层级。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          await deleteUnderstandingDocument(db, item.id);
          await refresh();
        },
      },
    ]);
  };

  const toggleScope = async (scope: ProjectUnderstandingScope, enabled: boolean) => {
    if (!projectId) return;
    await setProjectUnderstandingScopeEnabled(db, projectId, scope.scopeType, scope.scopeId, enabled);
    await refresh();
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <Stack.Screen options={{ title: 'AI 对你的了解' }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 18, paddingBottom: 96 + insets.bottom, gap: 16 }}
      >
        <View style={{ gap: 6 }}>
          <Text selectable style={{ color: colors.ink, fontSize: 24, lineHeight: 31, fontWeight: '800' }}>{title}</Text>
          <Text selectable style={{ color: colors.inkMuted, fontSize: 13.5, lineHeight: 21 }}>
            这些内容不会整份塞给 AI。发送前会根据当前问题选择相关条目；收藏和笔记始终是参考资料，只有“讲解偏好”可以调整表达方式。
          </Text>
        </View>

        {projectId && scopes.length ? (
          <View style={{ padding: 15, borderRadius: radii.large, borderCurve: 'continuous', backgroundColor: colors.surfaceStrong, boxShadow: floatingShadow, gap: 11 }}>
            <Text style={{ color: colors.ink, fontSize: 14.5, fontWeight: '800' }}>这张图会读取哪些层级</Text>
            {scopes.map((scope) => (
              <View key={`${scope.scopeType}:${scope.scopeId}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Pressable
                  style={{ flex: 1, gap: 2 }}
                  onPress={() => router.push({
                    pathname: '/ai-understanding',
                    params: {
                      projectId,
                      scopeType: scope.scopeType,
                      scopeId: scope.scopeId,
                      title: scope.label,
                    },
                  })}
                >
                  <Text style={{ color: colors.ink, fontSize: 12.5, fontWeight: '800' }}>{scope.label.trim()}</Text>
                  <Text style={{ color: colors.inkMuted, fontSize: 11 }}>{scope.documentCount} 条已启用内容</Text>
                </Pressable>
                <Switch
                  accessibilityLabel={`${scope.label}${scope.enabled ? '已启用' : '已停用'}`}
                  value={scope.enabled}
                  onValueChange={(value) => void toggleScope(scope, value)}
                  trackColor={{ false: colors.line, true: colors.blueSoft }}
                  thumbColor={scope.enabled ? colors.blue : colors.gray}
                />
              </View>
            ))}
          </View>
        ) : null}

        {grouped.map((group) => (
          <View key={group.id} style={{ gap: 9 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: group.color }} />
              <Text style={{ flex: 1, color: colors.ink, fontSize: 16, fontWeight: '800' }}>{group.label}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`添加${group.label}`}
                hitSlop={8}
                onPress={() => openEditor('new', group.id)}
              >
                <AppIcon name="add-circle-outline" color={group.color} size={22} />
              </Pressable>
            </View>
            <Text selectable style={{ color: colors.inkMuted, fontSize: 12, lineHeight: 18 }}>{group.description}</Text>
            {group.documents.length ? group.documents.map((item) => (
              <Pressable
                key={item.id}
                onPress={() => openEditor(item)}
                onLongPress={() => remove(item)}
                style={({ pressed }) => ({
                  padding: 15,
                  borderRadius: radii.medium,
                  borderCurve: 'continuous',
                  backgroundColor: colors.surfaceStrong,
                  boxShadow: floatingShadow,
                  gap: 7,
                  opacity: pressed ? 0.78 : 1,
                })}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: 14, fontWeight: '800' }}>{item.title}</Text>
                  <AppIcon name="edit" color={colors.inkMuted} size={17} />
                </View>
                <Text numberOfLines={3} selectable style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19 }}>{item.body}</Text>
              </Pressable>
            )) : (
              <Pressable
                onPress={() => openEditor('new', group.id)}
                style={({ pressed }) => ({
                  minHeight: 58,
                  borderRadius: radii.medium,
                  borderCurve: 'continuous',
                  borderWidth: 1,
                  borderStyle: 'dashed',
                  borderColor: colors.line,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Text style={{ color: colors.inkMuted, fontSize: 12.5 }}>添加第一条{group.label}</Text>
              </Pressable>
            )}
          </View>
        ))}
      </ScrollView>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="添加 AI 对你的了解"
        onPress={() => openEditor('new')}
        style={({ pressed }) => ({
          position: 'absolute',
          right: 20,
          bottom: Math.max(22, 14 + insets.bottom),
          minHeight: 54,
          borderRadius: 27,
          paddingHorizontal: 20,
          backgroundColor: colors.ink,
          boxShadow: floatingShadow,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          opacity: pressed ? 0.82 : 1,
        })}
      >
        <AppIcon name="add" color={colors.white} size={21} />
        <Text style={{ color: colors.white, fontSize: 14, fontWeight: '800' }}>添加</Text>
      </Pressable>

      <Modal visible={Boolean(editor)} transparent animationType="slide" onRequestClose={() => setEditor(null)}>
        <Pressable onPress={() => setEditor(null)} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(32,32,31,0.28)' }}>
          <Pressable onPress={() => undefined} style={{ maxHeight: '86%', borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: colors.surfaceStrong, padding: 20, paddingBottom: 20 + insets.bottom, gap: 14 }}>
            <Text style={{ color: colors.ink, fontSize: 20, fontWeight: '800' }}>{editor === 'new' ? '添加一条' : '编辑内容'}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {categoryOptions.map((option) => {
                const selected = draftCategory === option.id;
                return (
                  <Pressable
                    key={option.id}
                    onPress={() => setDraftCategory(option.id)}
                    style={({ pressed }) => ({
                      minHeight: 38,
                      paddingHorizontal: 13,
                      borderRadius: 19,
                      backgroundColor: selected ? `${option.color}22` : colors.canvas,
                      borderWidth: 1,
                      borderColor: selected ? option.color : colors.line,
                      alignItems: 'center',
                      justifyContent: 'center',
                      opacity: pressed ? 0.7 : 1,
                    })}
                  >
                    <Text style={{ color: selected ? colors.ink : colors.inkMuted, fontSize: 12, fontWeight: '800' }}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <TextInput
              value={draftTitle}
              onChangeText={setDraftTitle}
              placeholder="简短标题"
              placeholderTextColor={colors.gray}
              style={{ minHeight: 50, paddingHorizontal: 15, borderRadius: radii.medium, backgroundColor: colors.canvas, color: colors.ink, fontSize: 15, fontWeight: '700' }}
            />
            <TextInput
              value={draftBody}
              onChangeText={setDraftBody}
              placeholder="用 Markdown 写下希望 AI 知道的内容…"
              placeholderTextColor={colors.gray}
              multiline
              textAlignVertical="top"
              style={{ minHeight: 190, padding: 15, borderRadius: radii.large, backgroundColor: colors.canvas, color: colors.ink, fontSize: 14, lineHeight: 22 }}
            />
            <Pressable
              accessibilityRole="button"
              disabled={!draftTitle.trim() || !draftBody.trim() || saving}
              onPress={() => void save()}
              style={({ pressed }) => ({
                minHeight: 52,
                borderRadius: 26,
                backgroundColor: colors.ink,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: !draftTitle.trim() || !draftBody.trim() || saving ? 0.42 : pressed ? 0.82 : 1,
              })}
            >
              <Text style={{ color: colors.white, fontSize: 14.5, fontWeight: '800' }}>{saving ? '正在保存…' : '保存'}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
