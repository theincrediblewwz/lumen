import { useCallback, useState } from 'react';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/app-icon';
import {
  listFavorites,
  listProjectUnderstandingScopes,
  removeFavorite,
  setFavoriteBinding,
} from '@/data/personal-context';
import { colors, floatingShadow, radii } from '@/theme/tokens';
import type { FavoriteItem, ProjectUnderstandingScope } from '@/types/domain';

export default function FavoritesScreen() {
  const { projectId, nodeId } = useLocalSearchParams<{ projectId?: string; nodeId?: string }>();
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<FavoriteItem[]>([]);
  const [bindingFavorite, setBindingFavorite] = useState<FavoriteItem | null>(null);
  const [bindingScopes, setBindingScopes] = useState<ProjectUnderstandingScope[]>([]);

  const refresh = useCallback(async () => {
    setItems(await listFavorites(db, { projectId, nodeId }));
  }, [db, nodeId, projectId]);

  useFocusEffect(useCallback(() => {
    void refresh();
  }, [refresh]));

  const openSource = (item: FavoriteItem) => {
    if (item.targetType === 'answer') {
      router.push({ pathname: '/answer/[id]', params: { id: item.targetId } });
      return;
    }
    router.push({
      pathname: '/project/[id]',
      params: { id: item.projectId, initialNodeId: item.nodeId, favoriteJump: '1' },
    });
  };

  const remove = (item: FavoriteItem) => {
    Alert.alert('取消这条收藏？', '收藏引用也会一并移除，原节点或回答不会删除。', [
      { text: '保留', style: 'cancel' },
      {
        text: '取消收藏',
        style: 'destructive',
        onPress: async () => {
          await removeFavorite(db, item.id);
          await refresh();
        },
      },
    ]);
  };

  const openBindings = async (item: FavoriteItem) => {
    setBindingFavorite(item);
    setBindingScopes(await listProjectUnderstandingScopes(db, item.projectId));
  };

  const toggleBinding = async (scope: ProjectUnderstandingScope, enabled: boolean) => {
    if (!bindingFavorite) return;
    await setFavoriteBinding(db, bindingFavorite.id, scope.scopeType, scope.scopeId, enabled);
    const next = await listFavorites(db, { projectId, nodeId });
    setItems(next);
    const refreshed = next.find((item) => item.id === bindingFavorite.id) ?? null;
    setBindingFavorite(refreshed);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <Stack.Screen options={{ title: projectId ? '相关收藏' : '收藏' }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 18, paddingBottom: 36 + insets.bottom, gap: 14 }}
      >
        <View style={{ gap: 6 }}>
          <Text selectable style={{ color: colors.ink, fontSize: 24, fontWeight: '800' }}>
            {projectId ? '这里仍被收藏引用' : '收藏的学习内容'}
          </Text>
          <Text selectable style={{ color: colors.inkMuted, fontSize: 13.5, lineHeight: 21 }}>
            每条收藏都保留原图、原节点和原回答位置。只有你明确把收藏引用到某个“AI 对你的了解”层级，它才会成为可检索参考资料。
          </Text>
        </View>

        {items.length ? items.map((item) => {
          return (
            <View
              key={item.id}
              style={{
                padding: 16,
                borderRadius: radii.large,
                borderCurve: 'continuous',
                borderWidth: projectId ? 2 : 0,
                borderColor: projectId ? colors.coral : 'transparent',
                backgroundColor: colors.surfaceStrong,
                boxShadow: floatingShadow,
                gap: 11,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                <View style={{ width: 42, height: 42, borderRadius: 15, backgroundColor: item.targetType === 'answer' ? colors.blueSoft : colors.coralSoft, alignItems: 'center', justifyContent: 'center' }}>
                  <AppIcon name={item.targetType === 'answer' ? 'chat-bubble-outline' : 'account-tree'} color={item.targetType === 'answer' ? colors.blue : colors.coral} size={21} />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text numberOfLines={2} style={{ color: colors.ink, fontSize: 15, lineHeight: 21, fontWeight: '800' }}>{item.title}</Text>
                  <Text numberOfLines={2} style={{ color: colors.inkMuted, fontSize: 11.5, lineHeight: 17 }}>
                    {item.projectTitle} · {item.nodeTitle} · {item.targetType === 'answer' ? '回答' : '节点'}
                  </Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="取消收藏" hitSlop={8} onPress={() => remove(item)}>
                  <AppIcon name="bookmark" color={colors.amber} size={22} />
                </Pressable>
              </View>
              <Text numberOfLines={4} selectable style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19 }}>{plainPreview(item.body)}</Text>
              <View style={{ height: 1, backgroundColor: colors.line }} />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <FavoriteAction icon="my-location" label="回到原位置" onPress={() => openSource(item)} />
                <FavoriteAction
                  icon="psychology"
                  label={item.bindings.length ? `已引用 ${item.bindings.length} 层` : '让 AI 引用'}
                  tone="blue"
                  onPress={() => void openBindings(item)}
                />
              </View>
            </View>
          );
        }) : (
          <View style={{ minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <AppIcon name="bookmark-outline" color={colors.gray} size={38} />
            <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '800' }}>{projectId ? '相关收藏已经清理完' : '还没有收藏'}</Text>
            <Text style={{ color: colors.inkMuted, fontSize: 12.5, textAlign: 'center', lineHeight: 19 }}>
              节点操作和完整回答页面都可以收藏。
            </Text>
          </View>
        )}
      </ScrollView>

      <Modal visible={Boolean(bindingFavorite)} transparent animationType="slide" onRequestClose={() => setBindingFavorite(null)}>
        <Pressable onPress={() => setBindingFavorite(null)} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(32,32,31,0.28)' }}>
          <Pressable onPress={() => undefined} style={{ borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: colors.surfaceStrong, padding: 20, paddingBottom: 20 + insets.bottom, gap: 14 }}>
            <View style={{ gap: 4 }}>
              <Text style={{ color: colors.ink, fontSize: 19, fontWeight: '800' }}>让 AI 在哪些层级检索它</Text>
              <Text numberOfLines={2} style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 18 }}>{bindingFavorite?.title}</Text>
            </View>
            {bindingScopes.map((scope) => {
              const active = bindingFavorite?.bindings.some((binding) => (
                binding.scopeType === scope.scopeType && binding.scopeId === scope.scopeId
              )) ?? false;
              return (
                <View key={`${scope.scopeType}:${scope.scopeId}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: colors.ink, fontSize: 13, fontWeight: '800' }}>{scope.label.trim()}</Text>
                    <Text style={{ color: colors.inkMuted, fontSize: 11 }}>只建立索引引用，不复制收藏正文</Text>
                  </View>
                  <Switch
                    value={active}
                    onValueChange={(value) => void toggleBinding(scope, value)}
                    trackColor={{ false: colors.line, true: colors.blueSoft }}
                    thumbColor={active ? colors.blue : colors.gray}
                  />
                </View>
              );
            })}
            <View style={{ padding: 13, borderRadius: radii.medium, backgroundColor: colors.amberSoft, gap: 4 }}>
              <Text style={{ color: colors.ink, fontSize: 12.5, fontWeight: '800' }}>引用不是每次发送</Text>
              <Text style={{ color: colors.inkMuted, fontSize: 11.5, lineHeight: 17 }}>
                它只是进入候选索引。只有与当前问题相关并且没有超出预算时，发送预览才会显示它。
              </Text>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function FavoriteAction({
  icon,
  label,
  tone,
  onPress,
}: {
  icon: Parameters<typeof AppIcon>[0]['name'];
  label: string;
  tone?: 'blue';
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 42,
        borderRadius: 21,
        backgroundColor: tone === 'blue' ? colors.blueSoft : colors.canvas,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        opacity: pressed ? 0.72 : 1,
      })}
    >
      <AppIcon name={icon} color={tone === 'blue' ? colors.blue : colors.ink} size={18} />
      <Text style={{ color: colors.ink, fontSize: 11.5, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  );
}

function plainPreview(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/gu, ' [代码] ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^[#>*+-]+\s*/gmu, '')
    .replace(/[*_`~]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}
