import {importRichBoard} from '@/data/rich-board-files';
import { useCallback, useEffect, useState } from 'react';
import { Link, router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/app-icon';
import { shareInbox } from '@/components/share-inbox';
import { CanvasIconButton, canvasControlStyles } from '@/components/canvas-controls';
import { onSyncUpdate } from '@/sync/runtime';
import { listProjects } from '@/data/knowledge-repository';
import { getRecentBoardId, hasOpenedBoardThisProcess } from '@/data/canvas-state';
import { pickAndImportKnowledgeFolder } from '@/data/android-folder-transfer';
import {
  deleteEmptyTopic,
  getTopic,
  listTopicAncestors,
  listTopics,
  moveProjectToTopic,
} from '@/data/personal-context';
import { colors, radii } from '@/theme/tokens';
import type { LearningProject, Topic } from '@/types/domain';

let coldStartResumeFinished = false;
let coldStartResumePromise: Promise<string | null> | null = null;

export default function ProjectsScreen() {
  const { topicId } = useLocalSearchParams<{ topicId?: string }>();
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const [projects, setProjects] = useState<LearningProject[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [currentTopic, setCurrentTopic] = useState<Topic | null>(null);
  const [ancestors, setAncestors] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);
  const [resuming, setResuming] = useState(() => !shareInbox?.peekPendingShare() && !coldStartResumeFinished && !hasOpenedBoardThisProcess() && !topicId);

  useEffect(() => {
    if (shareInbox?.peekPendingShare()) { setResuming(false); return; }
    if (coldStartResumeFinished || hasOpenedBoardThisProcess() || topicId) { setResuming(false); return; }
    coldStartResumePromise ??= getRecentBoardId(db);
    let active = true;
    void coldStartResumePromise.then((projectId) => {
      if (!active) return;
      coldStartResumeFinished = true;
      if (projectId) router.replace({ pathname: '/project/[id]', params: { id: projectId } });
      else setResuming(false);
    }).catch(() => { if (active) { coldStartResumeFinished = true; setResuming(false); } });
    return () => { active = false; };
  }, [db, topicId]);

  const importPackage=async()=>{if(importing)return;setImporting(true);try{const id=await importRichBoard(db);if(id){if(topicId)await moveProjectToTopic(db,id,topicId);router.push({pathname:'/project/[id]',params:{id}});}}catch(e){Alert.alert('导入失败',e instanceof Error?e.message:'未导入');}finally{setImporting(false);}};
  const importFolder = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const result = await pickAndImportKnowledgeFolder(db);
      if (!result) return;
      if (topicId) await moveProjectToTopic(db, result.projectId, topicId);
      router.push({ pathname: '/project/[id]', params: { id: result.projectId } });
      if (result.kind === 'portable') Alert.alert('导入完成', `恢复 ${result.markdownCount} 篇文档、${result.restoredAssetCount} 份原件。${result.missingAssetCount ? `另有 ${result.missingAssetCount} 份旧来源原件缺失，仅保留提取文本。` : ''}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '请确认文件夹可读后重试';
      Alert.alert('导入失败', message);
    } finally {
      setImporting(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      let active = true;
      const refresh = () => { void Promise.all([
        listProjects(db, topicId ?? null),
        listTopics(db, topicId ?? null),
        topicId ? getTopic(db, topicId) : Promise.resolve(null),
        topicId ? listTopicAncestors(db, topicId) : Promise.resolve([]),
      ]).then(([projectItems, topicItems, topic, topicAncestors]) => {
        if (!active) return;
        setProjects(projectItems);
        setTopics(topicItems);
        setCurrentTopic(topic);
        setAncestors(topicAncestors);
        setLoading(false);
      }).catch(()=>{if(active)setLoading(false);}); };
      refresh();
      const unsubscribe=onSyncUpdate(refresh);
      return () => {
        active = false;
        unsubscribe();
      };
    }, [db, topicId]),
  );

  const deleteTopic = () => {
    if (!currentTopic) return;
    Alert.alert('删除这个空专题？', '只会删除当前专题，不会递归删除任何子专题或图谱。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除空专题',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteEmptyTopic(db, currentTopic.id);
            const parentId = currentTopic.parentId;
            router.replace(parentId ? { pathname: '/', params: { topicId: parentId } } : '/');
          } catch (error) {
            Alert.alert('专题没有删除', error instanceof Error ? error.message : '请稍后重试');
          }
        },
      },
    ]);
  };

  if (resuming) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas }}><ActivityIndicator color={colors.ink} /></View>;

  return (
    <View style={{ flex: 1, backgroundColor: '#FAFAF9' }}>
      <Stack.Screen
        options={{
          title: '白板',
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
              <Pressable accessibilityRole="button" accessibilityLabel="搜索文档与讨论" hitSlop={10} onPress={() => router.push('/search')}>
                <AppIcon name="search" color={colors.ink} size={23} />
              </Pressable>
              <CanvasIconButton icon="more-horiz" label="资料库菜单" onPress={() => setMenuVisible(true)} />
            </View>
          ),
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, paddingBottom: 112 + insets.bottom, gap: 20 }}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ alignItems: 'center', gap: 7 }}
        >
          <Pressable onPress={() => router.replace('/')} style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}>
            <Text style={{ color: topicId ? colors.inkMuted : colors.ink, fontSize: 12.5, fontWeight: '800' }}>全部</Text>
          </Pressable>
          {ancestors.map((topic) => (
            <View key={topic.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <AppIcon name="chevron-right" color={colors.gray} size={16} />
              <Pressable
                onPress={() => router.replace({ pathname: '/', params: { topicId: topic.id } })}
                style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
              >
                <Text
                  numberOfLines={1}
                  style={{ maxWidth: 160, color: topic.id === topicId ? colors.ink : colors.inkMuted, fontSize: 12.5, fontWeight: '800' }}
                >
                  {topic.title}
                </Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>

        <Pressable accessibilityRole="button" accessibilityLabel="打开独立知识库" onPress={() => router.push('/knowledge-library')} style={({ pressed }) => ({ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: colors.line, opacity: pressed ? 0.6 : 1 })}>
          <Text style={{ color: colors.ink, fontSize: 16 }}>知识库</Text>
          <AppIcon name="chevron-right" color={colors.inkMuted} size={18} />
        </Pressable>

        {currentTopic ? (
          <View style={{ padding: 15, borderRadius: radii.large, borderCurve: 'continuous', backgroundColor: colors.surfaceStrong, gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={{ color: colors.ink, fontSize: 18, fontWeight: '800' }}>{currentTopic.title}</Text>
                <Text style={{ color: colors.inkMuted, fontSize: 12 }}>
                  {currentTopic.childTopicCount} 个子专题 · {currentTopic.projectCount} 张图谱
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="设置当前专题的 AI 对你的了解"
                hitSlop={8}
                onPress={() => router.push({
                  pathname: '/ai-understanding',
                  params: { scopeType: 'topic', scopeId: currentTopic.id, title: currentTopic.title },
                })}
              >
                <AppIcon name="psychology" color={colors.blue} size={22} />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="删除空专题" hitSlop={8} onPress={deleteTopic}>
                <AppIcon name="delete-outline" color={colors.coral} size={21} />
              </Pressable>
            </View>
          </View>
        ) : null}

        {topics.length ? (
          <View style={{ gap: 11 }}>
            <Text style={{ color: colors.ink, fontSize: 18, fontWeight: '800' }}>专题</Text>
            {topics.map((topic) => (
              <Pressable
                key={topic.id}
                accessibilityRole="button"
                accessibilityLabel={`打开专题 ${topic.title}`}
                onPress={() => router.push({ pathname: '/', params: { topicId: topic.id } })}
                style={({ pressed }) => ({
                  minHeight: 76,
                  padding: 15,
                  borderRadius: radii.large,
                  borderCurve: 'continuous',
                  backgroundColor: colors.surfaceStrong,

                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  opacity: pressed ? 0.78 : 1,
                })}
              >
                <View style={{ width: 44, height: 44, borderRadius: 15, backgroundColor: colors.amberSoft, alignItems: 'center', justifyContent: 'center' }}>
                  <AppIcon name="folder" color={colors.amber} size={24} />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 16, fontWeight: '800' }}>{topic.title}</Text>
                  <Text style={{ color: colors.inkMuted, fontSize: 12 }}>{topic.childTopicCount} 个子专题 · {topic.projectCount} 张图谱</Text>
                </View>
                <AppIcon name="chevron-right" color={colors.inkMuted} size={20} />
              </Pressable>
            ))}
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: colors.ink, fontSize: 18, fontWeight: '800' }}>我的白板</Text>
          <Text style={{ color: colors.inkMuted, fontSize: 13, fontVariant: ['tabular-nums'] }}>{projects.length} 个</Text>
        </View>

        {loading ? (
          <ActivityIndicator color={colors.ink} />
        ) : (
          <View style={{ gap: 13 }}>
            {projects.map((project) => (
              <Link key={project.id} href={{ pathname: '/project/[id]', params: { id: project.id } }} asChild>
                <Pressable
                  style={({ pressed }) => ({
                    padding: 18,
                    borderRadius: radii.large,
                    borderCurve: 'continuous',
                    backgroundColor: colors.surfaceStrong,
                    borderWidth: 1, borderColor: '#EAE8E4',
                    gap: 14,
                    opacity: pressed ? 0.78 : 1,
                    transform: [{ scale: pressed ? 0.985 : 1 }],
                  })}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 13 }}>
                    <View
                      style={{
                        width: 46,
                        height: 46,
                        borderRadius: 16,
                        borderCurve: 'continuous',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: '#F7F7F5',
                      }}
                    >
                      <AppIcon name="account-tree" color={colors.inkMuted} size={24} />
                    </View>
                    <View style={{ flex: 1, gap: 5 }}>
                      <Text numberOfLines={2} style={{ color: colors.ink, fontSize: 18, lineHeight: 23, fontWeight: '800' }}>
                        {project.title}
                      </Text>
                      <Text numberOfLines={2} style={{ color: colors.inkMuted, fontSize: 13, lineHeight: 19 }}>
                        {project.sourceText || (project.graphKind === 'free' ? '连接想法、文档与讨论' : '从目标开始建立知识地图')}
                      </Text>
                    </View>
                    <AppIcon name="arrow-forward" color={colors.inkMuted} size={20} />
                  </View>
                  <View style={{ height: 1, backgroundColor: colors.line }} />
                  <View style={{ flexDirection: 'row', gap: 18 }}>
                    <Meta icon="hub" value={`${project.nodeCount} 个节点`} />

                  </View>
                </Pressable>
              </Link>
            ))}
          </View>
        )}
      </ScrollView>

      <View style={[canvasControlStyles.floating, { position: 'absolute', right: 20, bottom: insets.bottom + 20 }]}>
        <CanvasIconButton icon="add" label="新建或导入" onPress={() => setCreateVisible(true)} />
      </View>
      <Modal visible={createVisible || menuVisible} transparent animationType="fade" onRequestClose={() => { setCreateVisible(false); setMenuVisible(false); }}>
        <Pressable onPress={() => { setCreateVisible(false); setMenuVisible(false); }} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: colors.scrim }}>
          <Pressable onPress={() => undefined} style={{ margin: 14, marginBottom: insets.bottom + 14, padding: 12, borderRadius: 22, backgroundColor: colors.white, gap: 6 }}>
            {createVisible ? <>
              <BottomAction label="新建白板" icon="edit-note" onPress={() => { setCreateVisible(false); router.push({ pathname: '/new-node', params: topicId ? { topicId } : {} }); }} />
              <BottomAction label="从学习目标开始" icon="account-tree" onPress={() => { setCreateVisible(false); router.push({ pathname: '/new-project', params: topicId ? { topicId } : {} }); }} />
              <BottomAction label="导入完整白板 ZIP" icon="folder-open" disabled={importing} onPress={()=>{setCreateVisible(false);void importPackage();}}/>
              <BottomAction label={importing ? '导入中' : '导入项目或 Markdown 文件夹'} icon="folder-open" loading={importing} disabled={importing} onPress={() => { setCreateVisible(false); void importFolder(); }} />
              <BottomAction label="新建专题" icon="create-new-folder" onPress={() => { setCreateVisible(false); router.push({ pathname: '/new-topic', params: topicId ? { parentId: topicId } : {} }); }} />
            </> : <>
              <BottomAction label="应用与同步设置" icon="tune" onPress={() => { setMenuVisible(false); router.push('/settings'); }} />
            </>}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function BottomAction({
  label,
  icon,
  onPress,
  dark = false,
  loading = false,
  disabled = false,
}: {
  label: string;
  icon: Parameters<typeof AppIcon>[0]['name'];
  onPress: () => void;
  dark?: boolean;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexGrow: 0,
        minHeight: 52,
        borderRadius: 26,
        paddingHorizontal: 12,
        backgroundColor: dark ? colors.ink : colors.surfaceStrong,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        opacity: disabled ? 0.45 : pressed ? 0.78 : 1,
      })}
    >
      {loading
        ? <ActivityIndicator color={dark ? colors.white : colors.ink} size="small" />
        : <AppIcon name={icon} color={dark ? colors.white : colors.ink} size={20} />}
      <Text style={{ color: dark ? colors.white : colors.ink, fontSize: 12.5, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  );
}

function Meta({ icon, value }: { icon: Parameters<typeof AppIcon>[0]['name']; value: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <AppIcon name={icon} color={colors.inkMuted} size={16} />
      <Text style={{ color: colors.inkMuted, fontSize: 12.5, fontVariant: ['tabular-nums'] }}>{value}</Text>
    </View>
  );
}
