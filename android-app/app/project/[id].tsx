import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { ActivityIndicator, Alert, BackHandler, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { SlideInDown, SlideOutDown, useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated';

import { AI_DATA_CONSENT_DISCLOSURE, hasAiDataConsent, recordAiDataConsent } from '@/ai/ai-data-consent';
import { getByokDisclosure, hasByokDataConsent, recordByokDataConsent } from '@/ai/byok-data-consent';
import { getByokProfileStatus, type ByokProfile } from '@/ai/byok-profile';
import { prepareContextPreview } from '@/ai/context-preview-store';
import type { ExpansionQualityPath } from '@/ai/deep-build';
import {
  expandKnowledgeNode,
  getPreferredExpansionAdapter,
  type DeepBuildProgress,
} from '@/ai/expansion-service';
import { getAiGatewayUrl, getExpansionAdapterMode } from '@/ai/gateway-client';
import { claimInitialExpansion, clearInitialExpansionIntent } from '@/ai/initial-expansion-intent';
import { AppIcon } from '@/components/app-icon';
import { CanvasIconButton, CanvasSelectionCard, canvasControlStyles } from '@/components/canvas-controls';
import { FloatingButton } from '@/components/floating-button';
import { KnowledgeCanvas, type FocusPreset } from '@/components/knowledge-canvas';
import { moveNode } from '@/data/node-workspace';
import { onSyncUpdate } from '@/sync/runtime';
import { MarkdownContent } from '@/components/markdown-content';
import { pickAndExportProject, type ExportProgress } from '@/data/android-folder-transfer';
import type { ExpansionAdapter } from '@/data/expansion-jobs';
import { getLatestExpansionJobForProject } from '@/data/expansion-jobs';
import {
  deleteKnowledgeNode,
  deleteProject,
  getDocument,
  getGraph,
  getLatestAppliedGraphMutationBatch,
  getNodeDeleteImpact,
  reflowProjectGraph,
  type NodeDeleteImpact,
  undoGraphMutationBatch,
  updateEdgeReviewStatus,
  updateNodeStatus,
} from '@/data/knowledge-repository';
import { buildMasteryPrompt, type MasteryPrompt } from '@/data/mastery-check';
import { recordMasteryAttempt } from '@/data/mastery-attempts';
import { listNodeAnswers } from '@/data/node-answers';
import {
  FavoriteDependencyError,
  isNodeFavorite,
  setNodeFavorite,
} from '@/data/personal-context';
import { listPromptTemplates, savePromptTemplate } from '@/data/prompt-templates';
import { colors, floatingShadow, radii } from '@/theme/tokens';
import type { EdgeReviewStatus, KnowledgeEdge, KnowledgeGraph, KnowledgeNode, MarkdownDocument, PromptTemplate } from '@/types/domain';

function initialLayerPrompt(mode: KnowledgeGraph['project']['contentPolicy']['mode']) {
  if (mode === 'summary') {
    return '请忠实整理当前项目资料。先给出一份完整但不重复原文的概览，再生成第一层主题、主张、证据或组成部分；不要把资料没有表达的内容写成资料结论。';
  }
  return '请先分析这个学习目标。生成理解它真正需要的第一层关键学习点，并给出完整学习路线说明；不要深入展开第二层，除非缺少它会让第一层无法理解。';
}

export default function ProjectScreen() {
  const { id, initialNodeId, favoriteJump } = useLocalSearchParams<{
    id: string;
    initialNodeId?: string;
    favoriteJump?: string;
  }>();
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const safeFrame = useSafeAreaFrame();
  const keyboard = useAnimatedKeyboard();
  const initialAttemptFor = useRef<string | null>(null);
  const initialFocusFor = useRef<string | null>(null);
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [selected, setSelected] = useState<KnowledgeNode | KnowledgeEdge | null>(null);
  const [document, setDocument] = useState<MarkdownDocument | null>(null);
  const [prompt, setPrompt] = useState('');
  const [expanding, setExpanding] = useState(false);
  const [expansionQuality, setExpansionQuality] = useState<ExpansionQualityPath>('quick');
  const [deepProgress, setDeepProgress] = useState<DeepBuildProgress | null>(null);
  const [preparingPreview, setPreparingPreview] = useState(false);
  const [reviewingEdge, setReviewingEdge] = useState(false);
  const [expansionAdapter, setExpansionAdapter] = useState<ExpansionAdapter>('local');
  const [byokProfile, setByokProfile] = useState<ByokProfile | null>(null);
  const [jobWarning, setJobWarning] = useState<string | null>(null);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [answerCount, setAnswerCount] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [localDataVisible, setLocalDataVisible] = useState(false);
  const [projectMenuVisible, setProjectMenuVisible] = useState(false);
  const [movingNodeId, setMovingNodeId] = useState<string | null>(null);
  const [expansionVisible, setExpansionVisible] = useState(false);
  const [edgeReviewVisible, setEdgeReviewVisible] = useState(false);
  const [learningMarksVisible, setLearningMarksVisible] = useState(false);
  const expansionDrafts = useRef<Record<string, string>>({});
  const [fitRequest, setFitRequest] = useState(0);
  const [focusRequest, setFocusRequest] = useState(0);
  const [actionNode, setActionNode] = useState<KnowledgeNode | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<NodeDeleteImpact | null>(null);
  const [actionNodeFavorite, setActionNodeFavorite] = useState(false);
  const [nodeFocusPresets, setNodeFocusPresets] = useState<Record<string, FocusPreset>>({});
  const [masteryNode, setMasteryNode] = useState<KnowledgeNode | null>(null);
  const [masteryPrompt, setMasteryPrompt] = useState<MasteryPrompt | null>(null);
  const [masteryAnswer, setMasteryAnswer] = useState('');
  const [masteryRevealed, setMasteryRevealed] = useState(false);

  useFocusEffect(useCallback(() => {
    let active = true;
    Promise.all([getPreferredExpansionAdapter(), getByokProfileStatus()])
      .then(([adapter, status]) => {
        if (!active) return;
        setExpansionAdapter(adapter);
        setByokProfile(status.profile && status.hasApiKey ? status.profile : null);
      })
      .catch(() => {
        if (active) {
          setExpansionAdapter(getExpansionAdapterMode());
          setByokProfile(null);
        }
      });
    return () => { active = false; };
  }, []));

  useFocusEffect(useCallback(() => {
    let active = true;
    listPromptTemplates(db).then((items) => { if (active) setTemplates(items); });
    return () => { active = false; };
  }, [db]));

  const loadGraph = useCallback(async () => {
    if (!id) return;
    const [nextGraph, latestJob] = await Promise.all([getGraph(db, id), getLatestExpansionJobForProject(db, id)]);
    setGraph(nextGraph);
    setJobWarning(latestJob?.status === 'failed' ? latestJob.errorMessage ?? '最近一次 AI 回答失败；不会自动重试。' : null);
    setSelected((current) => {
      if (!nextGraph) return null;
      const refreshed = current
        ? nextGraph.nodes.find((item) => item.id === current.id) ?? nextGraph.edges.find((item) => item.id === current.id)
        : null;
      return refreshed ?? null;
    });
  }, [db, id]);

  useFocusEffect(useCallback(() => { void loadGraph().catch(() => setJobWarning('无法读取图谱，请重新打开。')); }, [loadGraph]));
  useEffect(()=>onSyncUpdate(()=>{if(!movingNodeId)void loadGraph().catch(()=>undefined);}),[loadGraph,movingNodeId]);

  useEffect(() => {
    if (!graph || !initialNodeId) return;
    const focusKey=`${id}:${initialNodeId}`;
    if (initialFocusFor.current===focusKey) return;
    const target = graph.nodes.find((node) => node.id === initialNodeId);
    if (!target) return;
    initialFocusFor.current=focusKey;
    setSelected(target);
    setFocusRequest((current) => current + 1);
  }, [graph, id, initialNodeId]);

  const selectedNode = useMemo(() => (selected && 'status' in selected ? selected : null), [selected]);
  const selectedNodeId = selectedNode?.id;
  const selectedEdge = useMemo(() => (selected && 'reviewStatus' in selected ? selected : null), [selected]);
  const selectedId = selected?.id ?? null;
  const selectedFocusPreset = selectedNode ? nodeFocusPresets[selectedNode.id] ?? 'coral' : 'coral';

  useEffect(() => {
    setExpansionVisible(false);
    setEdgeReviewVisible(false);
    setPrompt(selectedNodeId ? expansionDrafts.current[selectedNodeId] ?? '' : '');
  }, [selectedId, selectedNodeId]);

  const updatePrompt = (value: string) => {
    if (selectedNode) expansionDrafts.current[selectedNode.id] = value;
    setPrompt(value);
  };

  useEffect(() => {
    if (!selected) {
      setDocument(null);
      return;
    }
    let active = true;
    getDocument(db, selected.documentId).then((value) => { if (active) setDocument(value); });
    return () => { active = false; };
  }, [db, selected]);

  useEffect(() => {
    let active = true;
    if (!selectedNode) {
      setAnswerCount(0);
      return () => { active = false; };
    }
    listNodeAnswers(db, selectedNode.id).then((answers) => { if (active) setAnswerCount(answers.length); });
    return () => { active = false; };
  }, [db, selectedNode]);

  const composerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -keyboard.height.value }],
    maxHeight: Math.min(390, Math.max(160, safeFrame.height - insets.top - insets.bottom - keyboard.height.value - 80)),
  }));

  const clearSelection = useCallback(() => {
    Keyboard.dismiss();
    setExpansionVisible(false);
    setEdgeReviewVisible(false);
    setSelected(null);
  }, []);

  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (movingNodeId) { setMovingNodeId(null); return true; }
      if (expansionVisible || edgeReviewVisible) {
        Keyboard.dismiss(); setExpansionVisible(false); setEdgeReviewVisible(false); return true;
      }
      if (selected) { clearSelection(); return true; }
      return false;
    });
    return () => subscription.remove();
  }, [clearSelection, edgeReviewVisible, expansionVisible, movingNodeId, selected]));

  const openContextPreview = useCallback(async (
    target: KnowledgeNode | null = selectedNode,
    requestPrompt = prompt,
    qualityPath: ExpansionQualityPath = expansionQuality,
  ) => {
    if (!target || preparingPreview) return;
    setPreparingPreview(true);
    try {
      const previewId = await prepareContextPreview(
        db,
        target.id,
        requestPrompt.trim() || `继续拆解 ${target.title}`,
        qualityPath,
      );
      router.push({ pathname: '/ai-context-preview', params: { previewId } });
    } catch (error) {
      Alert.alert('无法建立发送预览', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setPreparingPreview(false);
    }
  }, [db, expansionQuality, preparingPreview, prompt, selectedNode]);

  const performExpansion = useCallback(async (
    target: KnowledgeNode,
    requestPrompt: string,
    qualityPath: ExpansionQualityPath,
    profileForLabel?: ByokProfile | null,
  ) => {
    if (expanding) return;
    setSelected(target);
    setExpanding(true);
    setDeepProgress(null);
    setJobWarning(null);
    try {
      const result = await expandKnowledgeNode(db, target.id, requestPrompt, {
        qualityPath,
        onProgress: setDeepProgress,
      });
      setPrompt('');
      delete expansionDrafts.current[target.id];
      await loadGraph();
      setAnswerCount((count) => count + 1);
      Alert.alert(
        `完整回答已保存，并展开 ${result.nodeCount} 个要点`,
        `${result.qualityPath === 'deep' ? '三阶段深入构建' : '快速生成'}已完成。${adapterLabel(result.adapter, profileForLabel ?? byokProfile)}把回答、${result.nodeCount} 个知识点和 ${result.edgeCount} 条关系一起保存。${result.actualModel ? ` 使用模型：${result.actualModel}。` : ''}${result.usage ? ` 三阶段合计 ${result.usage.totalTokens} tokens。` : ''}`,
        [
          {
            text: '撤销新节点',
            style: 'destructive',
            onPress: () => {
              void undoGraphMutationBatch(db, result.batchId)
                .then(async () => {
                  await loadGraph();
                  setSelected(target);
                  Alert.alert('已撤销本次图谱修改', '本次新增的节点和关系已移除；完整回答仍保留在回答记录中。');
                })
                .catch((error) => Alert.alert('无法撤销', error instanceof Error ? error.message : '请稍后重试'));
            },
          },
          { text: '留在图上', style: 'cancel' },
          { text: '读完整回答', onPress: () => router.push({ pathname: '/node-answers', params: { nodeId: target.id, title: target.title } }) },
        ],
      );
    } catch (error) {
      await loadGraph();
      const message = error instanceof Error ? error.message : '未知错误。任务状态已保留，可稍后手动重试。';
      setJobWarning(message);
      Alert.alert('回答没有写入图谱', message);
    } finally {
      setExpanding(false);
      setDeepProgress(null);
    }
  }, [byokProfile, db, expanding, loadGraph]);

  const requestExpansion = useCallback(async (
    target: KnowledgeNode,
    requestPrompt: string,
    qualityPath: ExpansionQualityPath = expansionQuality,
  ) => {
    if (expanding) return;
    let currentAdapter: ExpansionAdapter;
    let currentProfile: ByokProfile | null;
    try {
      const [adapter, status] = await Promise.all([getPreferredExpansionAdapter(), getByokProfileStatus()]);
      currentAdapter = adapter;
      currentProfile = status.profile && status.hasApiKey ? status.profile : null;
      setExpansionAdapter(adapter);
      setByokProfile(currentProfile);
    } catch {
      Alert.alert('无法读取 AI 连接状态', '请打开 AI 设置确认服务是否已经保存。');
      return;
    }
    if (currentAdapter === 'local') {
      Alert.alert('当前未连接 AI', '目标已经保留。配置个人 AI 后可生成真实第一层；也可以明确运行一次本地演示。', [
        { text: '稍后再说', style: 'cancel' },
        { text: '配置 AI', onPress: () => router.push('/ai-settings') },
        {
          text: '运行快速演示',
          onPress: () => { void performExpansion(target, requestPrompt, 'quick', currentProfile); },
        },
      ]);
      return;
    }
    if (qualityPath === 'deep' && currentAdapter !== 'byok') {
      Alert.alert('深入构建需要个人 AI', '深入构建会连续完成知识底稿、因人施教和图谱编排三个阶段。第一版只支持你在 App 内配置的个人 AI，不会静默改用 Gateway。');
      return;
    }
    const confirmAndPerform = () => {
      if (qualityPath === 'quick') {
        void performExpansion(target, requestPrompt, 'quick', currentProfile);
        return;
      }
      Alert.alert(
        '开始三阶段深入构建？',
        deepBuildDisclosure(currentProfile),
        [
          { text: '取消', style: 'cancel' },
          {
            text: '查看发送内容',
            onPress: () => { void openContextPreview(target, requestPrompt, 'deep'); },
          },
          {
            text: '开始深入构建',
            onPress: () => { void performExpansion(target, requestPrompt, 'deep', currentProfile); },
          },
        ],
      );
    };
    if (currentAdapter === 'byok') {
      if (!currentProfile) {
        Alert.alert('尚未配置个人 AI', '请先在 AI 设置中保存服务地址、模型和 API key。', [
          { text: '取消', style: 'cancel' },
          { text: '打开设置', onPress: () => router.push('/ai-settings') },
        ]);
        return;
      }
      try {
        if (!(await hasByokDataConsent(currentProfile))) {
          Alert.alert('发送给 AI 前确认', getByokDisclosure(currentProfile), [
            { text: '暂不发送', style: 'cancel' },
            { text: '查看发送内容', onPress: () => { void openContextPreview(target, requestPrompt, qualityPath); } },
            {
              text: '同意并继续',
              onPress: () => {
                void recordByokDataConsent(currentProfile)
                  .then(confirmAndPerform)
                  .catch((error) => Alert.alert('无法保存发送确认', error instanceof Error ? error.message : '请稍后重试'));
              },
            },
          ]);
          return;
        }
      } catch (error) {
        Alert.alert('无法读取发送设置', error instanceof Error ? error.message : '请稍后重试');
        return;
      }
    } else {
      const gatewayUrl = getAiGatewayUrl();
      if (!gatewayUrl) return;
      try {
        if (!(await hasAiDataConsent(gatewayUrl))) {
          Alert.alert('发送给 AI 前确认', AI_DATA_CONSENT_DISCLOSURE, [
            { text: '暂不发送', style: 'cancel' },
            { text: '查看发送内容', onPress: () => { void openContextPreview(target, requestPrompt, qualityPath); } },
            {
              text: '同意并继续',
              onPress: () => {
                void recordAiDataConsent(gatewayUrl)
                  .then(confirmAndPerform)
                  .catch((error) => Alert.alert('无法保存发送确认', error instanceof Error ? error.message : '请稍后重试'));
              },
            },
          ]);
          return;
        }
      } catch (error) {
        Alert.alert('无法读取发送设置', error instanceof Error ? error.message : '请稍后重试');
        return;
      }
    }
    confirmAndPerform();
  }, [expanding, expansionQuality, openContextPreview, performExpansion]);

  useEffect(() => {
    if (!id || !graph || favoriteJump === '1' || initialAttemptFor.current === id) return;
    const target = graph.nodes.find((node) => node.id === initialNodeId) ?? graph.nodes[0];
    if (!target) return;
    initialAttemptFor.current = id;
    claimInitialExpansion(id)
      .then((claimed) => {
        if (!claimed) return;
        setExpansionQuality('deep');
        void requestExpansion(target, initialLayerPrompt(graph.project.contentPolicy.mode), 'deep');
      })
      .catch((error) => setJobWarning(error instanceof Error ? error.message : '无法读取首次分析状态，请点击“生成第一层”重试。'));
  }, [favoriteJump, graph, id, initialNodeId, requestExpansion]);

  const expand = () => { if (selectedNode) void requestExpansion(selectedNode, prompt, expansionQuality); };

  const reviewEdge = async (reviewStatus: EdgeReviewStatus) => {
    if (!selectedEdge || reviewingEdge || selectedEdge.reviewStatus === reviewStatus) return;
    setReviewingEdge(true);
    try {
      const review = await updateEdgeReviewStatus(db, selectedEdge.id, reviewStatus);
      const updatedEdge = { ...selectedEdge, ...review };
      setSelected(updatedEdge);
      setGraph((current) => current ? { ...current, edges: current.edges.map((edge) => edge.id === updatedEdge.id ? updatedEdge : edge) } : current);
    } catch (error) {
      Alert.alert('无法保存关系判断', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setReviewingEdge(false);
    }
  };

  const saveCurrentPrompt = async () => {
    const body = prompt.trim();
    if (!body) return Alert.alert('先写下问题', '输入一段常用追问后再保存为模板。');
    try {
      const title = body.split(/\r?\n/)[0].replace(/[#>*_`]/g, '').trim().slice(0, 30) || '未命名模板';
      await savePromptTemplate(db, { title, body });
      setTemplates(await listPromptTemplates(db));
      Alert.alert('已保存为模板', `“${title}”会在每次选择节点后显示，可在 AI 设置中编辑。`);
    } catch (error) {
      Alert.alert('无法保存模板', error instanceof Error ? error.message : '请稍后重试');
    }
  };

  const exportProject = async () => {
    if (!graph || exporting) return;
    setExporting(true);
    setExportProgress({ current: 1, total: 7, label: '准备导出' });
    try {
      const result = await pickAndExportProject(db, graph.project.id, setExportProgress);
      if (!result) {
        setExportProgress(null);
        return;
      }
      Alert.alert('导出完成', `${result.directoryName}\n\n包含 ${result.documentCount} 份 Markdown、${result.sourceCount} 份资料的提取文本与定位、${result.masteryAttemptCount} 次掌握记录、完整图结构和 ${result.answerCount} 条已收藏回答。原始 PDF/图片不会复制。`);
    } catch (error) {
      Alert.alert('导出失败', error instanceof Error ? error.message : '请检查目标文件夹后重试');
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  };

  const confirmDeleteProject = () => {
    if (!graph) return;
    Alert.alert('删除这个学习项目？', '节点、连线、回答和文档都会从本机删除，此操作无法撤销。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除项目', style: 'destructive', onPress: async () => {
          try {
            await deleteProject(db, graph.project.id);
            await clearInitialExpansionIntent(graph.project.id);
            router.dismissTo('/');
          } catch (error) {
            if (error instanceof FavoriteDependencyError) {
              Alert.alert('这个项目仍被收藏引用', error.message, [
                { text: '取消', style: 'cancel' },
                {
                  text: '查看相关收藏',
                  onPress: () => router.push({ pathname: '/favorites', params: { projectId: graph.project.id } }),
                },
              ]);
              return;
            }
            Alert.alert('项目没有删除', error instanceof Error ? error.message : '请稍后重试');
          }
        },
      },
    ]);
  };

  const openNodeActions = useCallback((node: KnowledgeNode) => {
    setSelected(node);
    setActionNode(node);
    setDeleteImpact(null);
    Promise.all([getNodeDeleteImpact(db, node.id), isNodeFavorite(db, node.id)])
      .then(([impact, favorite]) => {
        setDeleteImpact(impact);
        setActionNodeFavorite(favorite);
      })
      .catch((error) => Alert.alert('无法读取节点信息', error instanceof Error ? error.message : '请稍后重试'));
  }, [db]);

  const setNodeState = async (status: KnowledgeNode['status']) => {
    if (!actionNode) return;
    try {
      await updateNodeStatus(db, actionNode.id, status);
      setActionNode(null);
      await loadGraph();
    } catch (error) {
      Alert.alert('无法更新节点', error instanceof Error ? error.message : '请稍后重试');
    }
  };

  const startMasteryCheck = async () => {
    if (!actionNode) return;
    try {
      const nodeDocument = await getDocument(db, actionNode.documentId);
      if (!nodeDocument) throw new Error('节点文档不存在');
      setMasteryNode(actionNode);
      setMasteryPrompt(buildMasteryPrompt(actionNode.title, nodeDocument.body));
      setMasteryAnswer('');
      setMasteryRevealed(false);
      setActionNode(null);
    } catch (error) {
      Alert.alert('无法开始自检', error instanceof Error ? error.message : '请稍后重试');
    }
  };

  const markMasteryPassed = async () => {
    if (!masteryNode || !masteryPrompt || !masteryAnswer.trim() || !masteryRevealed) return;
    const completedNode = masteryNode;
    try {
      await recordMasteryAttempt(db, {
        nodeId: completedNode.id,
        question: masteryPrompt.question,
        learnerAnswer: masteryAnswer,
        referencePoints: masteryPrompt.reference,
        decision: 'passed',
      });
      setMasteryNode(null);
      await loadGraph();
      const parentEdge = graph?.edges
        .filter((edge) => edge.targetId === completedNode.id)
        .sort((left, right) => right.importance - left.importance)[0];
      const parent = parentEdge ? graph?.nodes.find((node) => node.id === parentEdge.sourceId) : null;
      const returnToParent = (continueDiagnostic: boolean) => {
        if (!parent) return;
        setSelected(parent);
        setFocusRequest((current) => current + 1);
        if (continueDiagnostic && parent.status !== 'mastered') {
          setPrompt(`我已经完成「${completedNode.title}」的自检。请用一个具体问题重新诊断我是否真正理解「${parent.title}」；如果仍有缺口，只指出最小的下一步。`);
        }
      };
      Alert.alert('已记录这次自检', '你的回答、参考要点和自评结果已经保留。掌握状态仍表示自评，不等于外部事实核验。', [
        { text: '留在这里', style: 'cancel' },
        ...(parent ? [{
          text: '回到上一级',
          onPress: () => returnToParent(false),
        }, {
          text: '回上级并继续验证',
          onPress: () => returnToParent(true),
        }] : []),
      ]);
    } catch (error) {
      Alert.alert('无法保存自评结果', error instanceof Error ? error.message : '请稍后重试');
    }
  };

  const confirmUndoLatestExpansion = async () => {
    if (!graph) return;
    try {
      const batch = await getLatestAppliedGraphMutationBatch(db, graph.project.id);
      if (!batch) {
        Alert.alert('没有可撤销的 AI 扩展', '这个项目目前没有仍处于生效状态的 AI 图谱批次。');
        return;
      }
      Alert.alert(
        '撤销最近一次 AI 扩展？',
        `将尝试移除该批次新增的 ${batch.createdNodeIds.length} 个节点和 ${batch.createdEdgeIds.length} 条关系。完整回答会保留；如果内容后来被编辑、收藏、继续连接或用于掌握记录，仓库会拒绝撤销。`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '安全撤销',
            style: 'destructive',
            onPress: () => {
              void undoGraphMutationBatch(db, batch.id)
                .then(async () => {
                  setSelected(null);
                  await loadGraph();
                  Alert.alert('已撤销最近一次图谱修改', '新节点和关系已移除，完整回答仍保留在回答记录中。');
                })
                .catch((error) => Alert.alert('无法撤销', error instanceof Error ? error.message : '请稍后重试'));
            },
          },
        ],
      );
    } catch (error) {
      Alert.alert('无法读取撤销记录', error instanceof Error ? error.message : '请稍后重试');
    }
  };

  const markMasteryNeedsWork = async () => {
    if (!masteryNode || !masteryPrompt || !masteryAnswer.trim() || !masteryRevealed) return;
    try {
      await recordMasteryAttempt(db, {
        nodeId: masteryNode.id,
        question: masteryPrompt.question,
        learnerAnswer: masteryAnswer,
        referencePoints: masteryPrompt.reference,
        decision: 'continue_learning',
      });
      setMasteryNode(null);
      await loadGraph();
    } catch (error) {
      Alert.alert('无法保存自检记录', error instanceof Error ? error.message : '请稍后重试');
    }
  };

  const confirmDeleteNode = () => {
    const target = actionNode;
    const impact = deleteImpact;
    if (!target || !impact) return;
    if (impact.isRoot) return Alert.alert('不能删除根目标', '如需移除整个目标，请使用“删除项目”。');
    if (impact.activeJobCount > 0) return Alert.alert('暂时不能删除', '这个节点仍有 AI 任务在执行或等待恢复。');
    if (impact.favoriteCount > 0) {
      return Alert.alert('这个节点仍被收藏引用', `有 ${impact.favoriteCount} 条节点或回答收藏指向这里。请先取消收藏。`, [
        { text: '取消', style: 'cancel' },
        {
          text: '查看相关收藏',
          onPress: () => {
            setActionNode(null);
            router.push({ pathname: '/favorites', params: { projectId: target.projectId, nodeId: target.id } });
          },
        },
      ]);
    }
    Alert.alert(
      `删除“${impact.title}”？`,
      `会删除这个节点、${impact.edgeCount} 条相关连线和 ${impact.answerCount} 条回答记录。其他节点和仍被使用的文档会保留。此操作无法撤销。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除节点', style: 'destructive', onPress: async () => {
            try {
              await deleteKnowledgeNode(db, target.id);
              setActionNode(null);
              setSelected(null);
              await loadGraph();
            } catch (error) {
              if (error instanceof FavoriteDependencyError) {
                setActionNode(null);
                router.push({ pathname: '/favorites', params: { projectId: target.projectId, nodeId: target.id } });
                return;
              }
              Alert.alert('删除失败', error instanceof Error ? error.message : '所有改动已回滚，请稍后重试');
            }
          },
        },
      ],
    );
  };

  const toggleActionNodeFavorite = async () => {
    if (!actionNode) return;
    try {
      const next = !actionNodeFavorite;
      await setNodeFavorite(db, actionNode.id, next);
      setActionNodeFavorite(next);
      setDeleteImpact(await getNodeDeleteImpact(db, actionNode.id));
    } catch (error) {
      Alert.alert('收藏没有更新', error instanceof Error ? error.message : '请稍后重试');
    }
  };

  if (!graph) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas }}><ActivityIndicator color={colors.ink} /></View>;

  const onlyRoot = graph.nodes.length === 1;

  const arrangeGraph = async () => {
    try {
      await reflowProjectGraph(db, graph.project.id);
      await loadGraph();
      setFitRequest((current) => current + 1);
    } catch (error) {
      Alert.alert('无法整理图谱', error instanceof Error ? error.message : '请稍后重试');
    }
  };

  const switchLayoutDirection = async () => {
    const nextDirection = graph.project.layoutDirection === 'vertical' ? 'horizontal' : 'vertical';
    try {
      await reflowProjectGraph(db, graph.project.id, nextDirection);
      await loadGraph();
      setFitRequest((current) => current + 1);
    } catch (error) {
      Alert.alert('无法切换展开方向', error instanceof Error ? error.message : '请稍后重试');
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <KnowledgeCanvas
        nodes={graph.nodes}
        edges={graph.edges}
        selectedId={selectedId}
        focusPreset={selectedFocusPreset}
        showLearningMarks={learningMarksVisible}
        onSelectNode={setSelected}
        onSelectEdge={setSelected}
        onClearSelection={clearSelection}
        onLongPressNode={openNodeActions}
        movingNodeId={movingNodeId}
        onPreviewMove={(nodeId,x,y)=>setGraph(current=>current?{...current,nodes:current.nodes.map(n=>n.id===nodeId?{...n,x,y}:n)}:current)}
        onMoveNode={(nodeId,x,y)=>{void moveNode(db,nodeId,x,y).catch(e=>{Alert.alert('位置未保存',e.message);void loadGraph();});}}
        fitRequest={fitRequest}
        focusNodeId={initialNodeId ?? null}
        focusRequest={focusRequest}
      />

      <View pointerEvents="box-none" style={{ position: 'absolute', left: 16, right: 16, top: insets.top + 10, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={[canvasControlStyles.floating, { flex: 1, flexDirection: 'row', alignItems: 'center', maxWidth: 330 }]}>
          <CanvasIconButton icon="arrow-back" label="返回" onPress={() => router.canGoBack() ? router.back() : router.replace('/')} />
          <Text numberOfLines={1} style={{ flex: 1, paddingRight: 16, color: colors.ink, fontSize: 14, fontWeight: '600' }}>{graph.project.title}</Text>
        </View>
        <View style={canvasControlStyles.floating}>
          <CanvasIconButton icon="more-horiz" label="白板菜单" onPress={() => setProjectMenuVisible(true)} />
        </View>
      </View>

      {!selected && !movingNodeId ? <View style={[canvasControlStyles.floating, { position: 'absolute', right: 16, bottom: insets.bottom + 20 }]}>
        <CanvasIconButton icon="add" label="新建节点" onPress={() => router.push({ pathname: '/new-node', params: { projectId: id! } })} />
      </View> : null}

      {expanding && !expansionVisible ? <View accessibilityLiveRegion="polite" style={[canvasControlStyles.floating, { position: 'absolute', top: insets.top + 74, alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 9, flexDirection: 'row', gap: 8, alignItems: 'center' }]}>
        <ActivityIndicator size="small" color={colors.blue} /><Text style={{ color: colors.inkMuted, fontSize: 12 }}>正在扩展图谱…</Text>
      </View> : null}

      {selected && !movingNodeId && !expansionVisible ? <Animated.View entering={SlideInDown.duration(180)} exiting={SlideOutDown.duration(140)} style={{ position: 'absolute', left: 14, right: 14, bottom: insets.bottom + 12, maxHeight: safeFrame.height * 0.55 }}>
        <ScrollView showsVerticalScrollIndicator={false}>
          <CanvasSelectionCard title={selectedNode?.title || selectedEdge?.label || '关系'} subtitle={document && document.id === selected.documentId ? plainPreview(document.body) : undefined} onClose={clearSelection}>
            <View style={{ flexDirection: 'row', gap: 4 }}>
              <SmallAction icon="description" label="阅读" onPress={() => router.push({ pathname: '/document/[id]', params: { id: selected.documentId } })} />
              {selectedNode ? <>
                <SmallAction icon="chat-bubble-outline" label="讨论" onPress={() => router.push({ pathname: '/discussion', params: { projectId: id!, nodeId: selectedNode.id } })} />
                <SmallAction icon="more-horiz" label="更多" onPress={() => openNodeActions(selectedNode)} />
              </> : <SmallAction icon="tune" label={edgeReviewVisible ? '收起判断' : '关系判断'} onPress={() => setEdgeReviewVisible(current => !current)} />}
            </View>
            {selectedEdge && edgeReviewVisible ? <EdgeReviewPanel edge={selectedEdge} disabled={reviewingEdge} onChange={reviewEdge} /> : null}
          </CanvasSelectionCard>
        </ScrollView>
      </Animated.View> : null}

      {movingNodeId ? <View style={{position:'absolute',left:16,right:16,bottom:24+insets.bottom,padding:16,backgroundColor:colors.surfaceStrong,borderRadius:20,gap:10}}><Text style={{color:colors.ink}}>拖动屏幕放置节点，位置会自动保存。</Text><Pressable accessibilityRole="button" onPress={()=>setMovingNodeId(null)} style={{padding:14,backgroundColor:colors.blueSoft,borderRadius:18}}><Text style={{color:colors.blue,textAlign:'center'}}>完成移动</Text></Pressable></View> : null}
      {selectedNode && expansionVisible && !movingNodeId ? (
        <Animated.View
          entering={SlideInDown.duration(220)}
          exiting={SlideOutDown.duration(180)}
          style={[
            {
              position: 'absolute',
              left: 14,
              right: 14,
              bottom: Math.max(14, insets.bottom + 10),
              zIndex: 50,
              elevation: 50,
              gap: 9,
              overflow: 'hidden',
            },
            composerStyle,
          ]}
        >
        <Pressable accessibilityLabel="扩展图谱面板" onPress={() => undefined} style={StyleSheet.absoluteFill} />
        <ScrollView
          style={{ flexGrow: 0, flexShrink: 1 }}
          contentContainerStyle={{ gap: 9, paddingBottom: 2 }}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
        >
        {expanding ? (
          <View accessibilityLiveRegion="polite" accessibilityLabel="模型正在回答" style={{ alignSelf: 'center', minHeight: 38, borderRadius: 19, paddingHorizontal: 15, backgroundColor: 'rgba(255, 252, 247, 0.98)', boxShadow: floatingShadow, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator size="small" color={colors.blue} />
            <Text style={{ color: colors.ink, fontSize: 12, fontWeight: '800' }}>
              {deepProgress
                ? `深入构建 ${deepProgress.current}/3 · ${deepProgress.label}`
                : `模型正在回答 · ${adapterStatusLabel(expansionAdapter, byokProfile)}`}
            </Text>
          </View>
        ) : null}

        <View style={[canvasControlStyles.floating, { flexDirection: 'row', alignItems: 'center', paddingLeft: 16 }]}>
          <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: 14, fontWeight: '600' }}>扩展 · {selectedNode.title}</Text>
          <CanvasIconButton icon="close" label="收起扩展面板" onPress={() => { Keyboard.dismiss(); setExpansionVisible(false); }} />
        </View>

        {onlyRoot && selectedNode && graph.project.graphKind !== 'free' ? (
          <View style={{ borderRadius: radii.medium, borderCurve: 'continuous', backgroundColor: 'rgba(231, 238, 252, 0.98)', padding: 13, boxShadow: '0 5px 18px rgba(55, 48, 40, 0.08)', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={{ color: colors.ink, fontSize: 12.5, fontWeight: '800' }}>
                {graph.project.contentPolicy.mode === 'summary' ? '还没有第一层总结节点' : '还没有第一层学习点'}
              </Text>
              <Text style={{ color: colors.inkMuted, fontSize: 11.5, lineHeight: 17 }}>
                {graph.project.contentPolicy.mode === 'summary'
                  ? '资料已安全保留；可让 AI 重新整理第一层。'
                  : '目标已安全保留；可让 AI 重新分析第一层。'}
              </Text>
            </View>
            <Pressable disabled={expanding} onPress={() => void requestExpansion(selectedNode, initialLayerPrompt(graph.project.contentPolicy.mode), 'deep')} style={({ pressed }) => ({ minHeight: 38, borderRadius: 19, paddingHorizontal: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.ink, opacity: expanding ? 0.45 : pressed ? 0.78 : 1 })}>
              <Text style={{ color: colors.white, fontSize: 11.5, fontWeight: '800' }}>
                {graph.project.contentPolicy.mode === 'summary' ? '深入整理第一层' : '深入生成第一层'}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {jobWarning ? <View accessibilityLiveRegion="polite" style={{ borderRadius: radii.medium, borderCurve: 'continuous', backgroundColor: 'rgba(248, 238, 219, 0.98)', paddingHorizontal: 14, paddingVertical: 11, boxShadow: '0 5px 18px rgba(55, 48, 40, 0.08)' }}><Text selectable style={{ color: colors.ink, fontSize: 12, lineHeight: 18 }}>{jobWarning}</Text></View> : null}

        </ScrollView>

        {selectedNode ? (
        <View style={{ minHeight: 96, flexShrink: 0, borderRadius: radii.large, borderCurve: 'continuous', backgroundColor: colors.surfaceStrong, padding: 7, gap: 5, boxShadow: floatingShadow }}>
          <View style={{ minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 11 }}>
            <TextInput
              value={prompt}
              onChangeText={updatePrompt}
              editable={Boolean(selectedNode) && !expanding}
              accessibilityLabel="扩展图谱的问题"
              placeholder="想从这个节点展开什么？"
              placeholderTextColor={colors.gray}
              onSubmitEditing={expand}
              returnKeyType="send"
              style={{ flex: 1, color: colors.ink, fontSize: 14.5, paddingVertical: 10 }}
            />
            <Pressable accessibilityRole="button" accessibilityLabel="保存当前文字为询问模板" disabled={!prompt.trim() || expanding} onPress={saveCurrentPrompt} style={({ pressed }) => ({ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas, opacity: !prompt.trim() || expanding ? 0.35 : pressed ? 0.7 : 1 })}>
              <AppIcon name="bookmark-add" color={colors.ink} size={20} />
            </Pressable>
            <FloatingButton accessibilityLabel={expanding ? '模型正在回答' : '扩展图谱'} icon="arrow-upward" onPress={expand} tone="dark" disabled={!selectedNode || expanding} loading={expanding} />
          </View>
          {selectedNode ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 7, paddingBottom: 4, gap: 7 }}>

              <QualityChip
                label="快速 · 1 次"
                selected={expansionQuality === 'quick'}
                disabled={expanding}
                onPress={() => setExpansionQuality('quick')}
              />
              <QualityChip
                label="深入 · 3 阶段"
                selected={expansionQuality === 'deep'}
                disabled={expanding}
                onPress={() => setExpansionQuality('deep')}
              />
              <SmallAction icon="visibility" label={preparingPreview ? "准备预览" : "发送预览"} onPress={() => { void openContextPreview(); }} />
              {templates.map((template) => (
                <Pressable key={template.id} accessibilityRole="button" onPress={() => updatePrompt(template.body)} style={({ pressed }) => ({ minHeight: 34, paddingHorizontal: 12, borderRadius: 17, borderCurve: 'continuous', backgroundColor: colors.blueSoft, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}>
                  <Text numberOfLines={1} style={{ maxWidth: 180, color: colors.blue, fontSize: 11.5, fontWeight: '800' }}>{template.title}</Text>
                </Pressable>
              ))}
              <Pressable accessibilityRole="button" onPress={() => router.push('/prompt-templates')} style={({ pressed }) => ({ minHeight: 34, paddingHorizontal: 12, borderRadius: 17, borderCurve: 'continuous', borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}>
                <Text style={{ color: colors.inkMuted, fontSize: 11.5, fontWeight: '700' }}>{templates.length ? '管理模板' : '新建模板'}</Text>
              </Pressable>
            </ScrollView>
          ) : null}
        </View>
        ) : null}
        </Animated.View>
      ) : null}

      <Modal visible={projectMenuVisible} transparent animationType="fade" onRequestClose={() => setProjectMenuVisible(false)}>
        <Pressable onPress={() => setProjectMenuVisible(false)} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(32,32,31,0.28)' }}>
          <Pressable onPress={() => undefined} style={{ marginHorizontal: 12, marginBottom: 12 + insets.bottom, borderRadius: 30, borderCurve: 'continuous', backgroundColor: colors.surfaceStrong, padding: 10, gap: 3, maxHeight: '90%', boxShadow: floatingShadow }}><ScrollView>
            <View style={{ paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8, gap: 3 }}>
              <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 19, fontWeight: '800' }}>{graph.project.title}</Text>
              <Text style={{ color: colors.inkMuted, fontSize: 12 }}>
                {graph.project.graphKind === 'free' ? '自由白板' : graph.project.contentPolicy.mode === 'summary' ? '总结图' : '学习图'}
              </Text>
            </View>
            <ProjectMenuItem icon="filter-center-focus" title="显示全部节点" description="只调整视野，保留节点位置" onPress={() => { setProjectMenuVisible(false); setFitRequest(current => current + 1); }} />
            <ProjectMenuItem icon="palette" title={learningMarksVisible ? '收起学习标记' : '显示学习标记'} description="按需显示重要程度、学习状态和颜色说明" onPress={() => { setLearningMarksVisible(current => !current); setProjectMenuVisible(false); }} />
            <ProjectMenuItem icon="settings" title="应用与同步设置" description="跨设备同步、备份与应用选项" onPress={() => { setProjectMenuVisible(false); router.push('/settings'); }} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, padding: 12 }}><Legend color={colors.coral} label="关键" /><Legend color={colors.blue} label="学习中" /><Legend color={colors.green} label="自评掌握" /><Legend color={colors.amber} label="待验证" /></View>
            <ProjectMenuItem icon="add" title="新建节点" description="写一篇文档，连接自己的想法" onPress={()=>{setProjectMenuVisible(false);router.push({pathname:'/new-node',params:{projectId:id!,...(selectedNode?{parentId:selectedNode.id}:{})}});}}/>
            <ProjectMenuItem icon="forum" title="图谱讨论" description="查看连续对话，把有用的内容保存为节点" onPress={()=>{setProjectMenuVisible(false);router.push({pathname:'/discussion',params:{projectId:id!}});}}/>
            <ProjectMenuItem icon="search" title="搜索图谱内容" description="查找文档、资料和对话原文" onPress={()=>{setProjectMenuVisible(false);router.push({pathname:'/search',params:{projectId:id!}});}}/>
            <ProjectMenuItem
              icon="tune"
              title="内容与资料"
              description="图谱模式、说人话、内容长度与资料来源"
              onPress={() => {
                setProjectMenuVisible(false);
                router.push({ pathname: '/project-settings', params: { projectId: graph.project.id } });
              }}
            />
            <ProjectMenuItem
              icon="smart-toy"
              title="AI 连接与发送"
              description="模型、接口地址、发送确认与询问模板"
              onPress={() => {
                setProjectMenuVisible(false);
                router.push('/ai-settings');
              }}
            />
            <ProjectMenuItem
              icon="psychology"
              title="AI 对你的了解"
              description="选择全局、专题和当前图谱哪些层级会生效"
              onPress={() => {
                setProjectMenuVisible(false);
                router.push({
                  pathname: '/ai-understanding',
                  params: {
                    projectId: graph.project.id,
                    scopeType: 'project',
                    scopeId: graph.project.id,
                    title: `当前图谱 · ${graph.project.title}`,
                  },
                });
              }}
            />
            <ProjectMenuItem
              icon="bookmarks"
              title="相关收藏"
              description="查看节点和回答收藏、原始位置及 AI 引用"
              onPress={() => {
                setProjectMenuVisible(false);
                router.push({ pathname: '/favorites', params: { projectId: graph.project.id } });
              }}
            />
            <ProjectMenuItem
              icon="folder"
              title="移动到专题"
              description="调整首页层级，不改动图谱内容和上下文"
              onPress={() => {
                setProjectMenuVisible(false);
                router.push({ pathname: '/move-project', params: { projectId: graph.project.id } });
              }}
            />
            <ProjectMenuItem
              icon="folder"
              title="导出当前项目"
              description="选择文件夹，导出 Markdown、图结构与收藏回答"
              onPress={() => {
                setProjectMenuVisible(false);
                setLocalDataVisible(true);
              }}
            />
            <ProjectMenuItem
              icon="account-tree"
              title="整理并居中"
              description={`按${graph.project.layoutDirection === 'horizontal' ? '横向' : '纵向'}层级重新排列节点并完整显示`}
              onPress={() => {
                setProjectMenuVisible(false);
                void arrangeGraph();
              }}
            />
            <ProjectMenuItem
              icon="swap-horiz"
              title={graph.project.layoutDirection === 'vertical' ? '切换为横向展开' : '切换为纵向展开'}
              description={graph.project.layoutDirection === 'vertical' ? '层级从左向右展开并重新居中' : '层级从上向下展开并重新居中'}
              onPress={() => {
                setProjectMenuVisible(false);
                void switchLayoutDirection();
              }}
            />
            <ProjectMenuItem
              icon="undo"
              title="撤销最近一次 AI 扩展"
              description="仅在新增内容未被编辑、收藏、继续连接或用于自检时执行"
              onPress={() => {
                setProjectMenuVisible(false);
                void confirmUndoLatestExpansion();
              }}
            />
            <View style={{ height: 1, marginHorizontal: 12, backgroundColor: colors.line }} />
            <ProjectMenuItem
              icon="delete-outline"
              title="删除整个项目"
              description="删除节点、连线、回答和文档"
              destructive
              onPress={() => {
                setProjectMenuVisible(false);
                confirmDeleteProject();
              }}
            />
          </ScrollView></Pressable>
        </Pressable>
      </Modal>

      <Modal visible={Boolean(actionNode)} transparent animationType="fade" onRequestClose={() => setActionNode(null)}>
        <Pressable onPress={() => setActionNode(null)} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(32,32,31,0.28)' }}>
          <Pressable onPress={() => undefined} style={{ borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: colors.surfaceStrong, maxHeight: '88%' }}>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 22 + insets.bottom, gap: 16 }}>
            <View style={{ gap: 4 }}>
              <Text style={{ color: colors.ink, fontSize: 19, fontWeight: '800' }}>{actionNode?.title}</Text>
              <Text style={{ color: colors.inkMuted, fontSize: 12.5 }}>文档、图谱与学习操作</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <SheetButton label="管理文档" onPress={() => { const nodeId = actionNode!.id; setActionNode(null); router.push({ pathname: '/node-documents', params: { nodeId } }); }} />
              <SheetButton label="扩展图谱" tone="blue" onPress={() => { setActionNode(null); setExpansionVisible(true); }} />
            </View>
            <SheetButton label={`回答记录 · ${answerCount}`} onPress={() => { const node = actionNode!; setActionNode(null); router.push({ pathname: '/node-answers', params: { nodeId: node.id, title: node.title } }); }} />
            <View style={{flexDirection:'row',gap:8}}>
              <SheetButton label="移动节点" onPress={()=>{setMovingNodeId(actionNode!.id);setActionNode(null);}}/>
              <SheetButton label="添加子节点" onPress={()=>{const parentId=actionNode!.id;setActionNode(null);router.push({pathname:'/new-node',params:{projectId:id!,parentId}});}}/>
            </View>
            <View style={{ gap: 9 }}>
              <Text style={{ color: colors.ink, fontSize: 12.5, fontWeight: '800' }}>醒目边框预设（仅当前使用会话）</Text>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                {focusPresets.map((item) => {
                  const active = actionNode ? (nodeFocusPresets[actionNode.id] ?? 'coral') === item.id : false;
                  return <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={`${item.label}高亮边框`} onPress={() => actionNode && setNodeFocusPresets((current) => ({ ...current, [actionNode.id]: item.id }))} style={({ pressed }) => ({ width: 46, height: 46, borderRadius: 23, borderWidth: active ? 5 : 2, borderColor: item.color, backgroundColor: `${item.color}20`, opacity: pressed ? 0.7 : 1 })} />;
                })}
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <SheetButton label="学习中" onPress={() => void setNodeState('learning')} />
              <SheetButton label="待验证" onPress={() => void setNodeState('uncertain')} />
              <SheetButton label="开始自检" onPress={() => void startMasteryCheck()} tone="blue" />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: actionNodeFavorite }}
              onPress={() => void toggleActionNodeFavorite()}
              style={({ pressed }) => ({
                minHeight: 46,
                borderRadius: 23,
                backgroundColor: actionNodeFavorite ? colors.amberSoft : colors.canvas,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                opacity: pressed ? 0.72 : 1,
              })}
            >
              <AppIcon name={actionNodeFavorite ? 'bookmark' : 'bookmark-outline'} color={actionNodeFavorite ? colors.amber : colors.ink} size={20} />
              <Text style={{ color: colors.ink, fontSize: 12.5, fontWeight: '800' }}>{actionNodeFavorite ? '已收藏这个节点' : '收藏这个节点'}</Text>
            </Pressable>
            <View style={{ height: 1, backgroundColor: colors.line }} />
            <Pressable accessibilityRole="button" disabled={!deleteImpact || deleteImpact.isRoot || deleteImpact.activeJobCount > 0} onPress={confirmDeleteNode} style={({ pressed }) => ({ minHeight: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.coralSoft, opacity: !deleteImpact || deleteImpact.isRoot || deleteImpact.activeJobCount > 0 ? 0.45 : pressed ? 0.72 : 1 })}>
              <Text style={{ color: colors.coral, fontWeight: '800' }}>{deleteImpact?.isRoot ? '根目标请在项目设置中删除' : deleteImpact?.activeJobCount ? 'AI 回答结束后才能删除' : '删除这个节点'}</Text>
            </Pressable>
          </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={Boolean(masteryNode && masteryPrompt)} transparent animationType="slide" onRequestClose={() => setMasteryNode(null)}>
        <View style={{ flex: 1, backgroundColor: colors.surfaceStrong, paddingTop: insets.top }}>
          <View style={{ padding: 18, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: colors.line }}>
            <View style={{ flex: 1, gap: 3 }}><Text style={{ color: colors.ink, fontSize: 19, fontWeight: '800' }}>自检 · {masteryNode?.title}</Text><Text style={{ color: colors.inkMuted, fontSize: 12 }}>这里不做 AI 自动评分，由你对照参考后自评。</Text></View>
            <Pressable onPress={() => setMasteryNode(null)} hitSlop={10}><AppIcon name="close" color={colors.ink} size={24} /></Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 18, paddingBottom: 36 + insets.bottom, gap: 14 }}>
            <View style={{ padding: 16, borderRadius: radii.large, backgroundColor: colors.blueSoft, gap: 7 }}>
              <Text style={{ color: colors.blue, fontSize: 12, fontWeight: '800' }}>请先回答</Text>
              <MarkdownContent value={masteryPrompt?.question ?? ''} contentPadding={0} backgroundColor={colors.blueSoft} scrollEnabled={false} />
            </View>
            <TextInput value={masteryAnswer} onChangeText={setMasteryAnswer} multiline textAlignVertical="top" placeholder="用自己的话回答，尽量给出例子……" placeholderTextColor={colors.gray} style={{ minHeight: 180, borderRadius: radii.large, backgroundColor: colors.canvas, padding: 16, color: colors.ink, fontSize: 15, lineHeight: 24 }} />
            {!masteryRevealed ? (
              <Pressable disabled={!masteryAnswer.trim()} onPress={() => setMasteryRevealed(true)} style={({ pressed }) => ({ minHeight: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.ink, opacity: !masteryAnswer.trim() ? 0.4 : pressed ? 0.8 : 1 })}><Text style={{ color: colors.white, fontWeight: '800' }}>写完了，显示参考</Text></Pressable>
            ) : (
              <>
                <View style={{ padding: 16, borderRadius: radii.large, backgroundColor: colors.amberSoft, gap: 7 }}>
                  <Text style={{ color: colors.amber, fontSize: 12, fontWeight: '800' }}>节点文档参考（未经外部事实核验）</Text>
                  <MarkdownContent value={masteryPrompt?.reference ?? ''} contentPadding={0} backgroundColor={colors.amberSoft} scrollEnabled={false} />
                </View>
                <Text style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19 }}>比较你的回答是否覆盖核心概念、因果关系和一个具体例子。拿不准时选“继续学习”。</Text>
                <View style={{ flexDirection: 'row', gap: 9 }}><SheetButton label="继续学习" onPress={() => void markMasteryNeedsWork()} /><SheetButton label="我自评通过" onPress={() => void markMasteryPassed()} tone="green" /></View>
              </>
            )}
          </ScrollView>
        </View>
      </Modal>

      <Modal visible={localDataVisible} transparent animationType="slide" onRequestClose={() => setLocalDataVisible(false)}>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(32,32,31,0.28)' }}>
          <View style={{ maxHeight: '90%', borderTopLeftRadius: 30, borderTopRightRadius: 30, borderCurve: 'continuous', backgroundColor: colors.surfaceStrong, overflow: 'hidden' }}>
            <View style={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={{ color: colors.ink, fontSize: 20, fontWeight: '800' }}>导出当前项目</Text>
                <Text style={{ color: colors.inkMuted, fontSize: 12 }}>主动创建一个可分享、可重新导入的项目包</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="关闭项目导出" onPress={() => setLocalDataVisible(false)} hitSlop={10}><AppIcon name="close" color={colors.ink} size={24} /></Pressable>
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 + insets.bottom, gap: 13 }} showsVerticalScrollIndicator={false}>
              <View style={{ padding: 15, borderRadius: radii.large, borderCurve: 'continuous', backgroundColor: colors.canvas, gap: 10 }}>
                <View style={{ gap: 3 }}>
                  <Text style={{ color: colors.ink, fontSize: 14, fontWeight: '800' }}>主动导出当前项目</Text>
                  <Text style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19 }}>创建 Markdown、完整图结构和已收藏回答；不会把目标文件夹当成实时工作区。</Text>
                </View>
                {exportProgress ? <ProgressRow current={exportProgress.current} total={exportProgress.total} label={exportProgress.label} detail={exportProgress.detail} /> : null}
                <Pressable disabled={exporting} onPress={() => void exportProject()} style={({ pressed }) => ({ minHeight: 50, borderRadius: 25, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center', opacity: exporting ? 0.5 : pressed ? 0.8 : 1 })}>
                  <Text style={{ color: colors.white, fontWeight: '800' }}>{exporting ? `正在导出 ${exportProgress?.current ?? 1}/7` : '选择文件夹并导出当前项目'}</Text>
                </Pressable>
              </View>

              <DataBoundary title="自动备份在哪里设置？" body="自动备份属于整个应用，只需在首页右上角的“应用设置”选择一次文件夹；每个项目会在该备份根目录下拥有自己的可读子文件夹。这里的主动导出只处理当前项目，并让你每次自行选择目标位置。" />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function QualityChip({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={`生成方式：${label}`}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 34,
        paddingHorizontal: 12,
        borderRadius: 17,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: selected ? colors.ink : colors.line,
        backgroundColor: selected ? colors.ink : colors.surfaceStrong,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.5 : pressed ? 0.72 : 1,
      })}
    >
      <Text style={{ color: selected ? colors.white : colors.inkMuted, fontSize: 11.5, fontWeight: '800' }}>
        {label}
      </Text>
    </Pressable>
  );
}

function SmallAction({ icon, label, onPress }: { icon: Parameters<typeof AppIcon>[0]['name']; label: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ flex: 1, minHeight: 48, paddingHorizontal: 12, borderRadius: 12, backgroundColor: pressed ? '#F0EFEB' : '#F7F7F5', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 })}><AppIcon name={icon} color={colors.inkMuted} size={19} /><Text style={{ color: colors.ink, fontSize: 13, fontWeight: '500' }}>{label}</Text></Pressable>;
}

function SheetButton({ label, onPress, tone }: { label: string; onPress: () => void; tone?: 'blue' | 'green' }) {
  const backgroundColor = tone === 'blue' ? colors.blueSoft : tone === 'green' ? colors.greenSoft : colors.canvas;
  const foregroundColor = tone === 'blue' ? colors.blue : tone === 'green' ? colors.green : colors.ink;
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ flex: 1, minHeight: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor, opacity: pressed ? 0.72 : 1 })}><Text style={{ color: foregroundColor, fontSize: 12.5, fontWeight: '800' }}>{label}</Text></Pressable>;
}

function DataBoundary({ title, body }: { title: string; body: string }) {
  return <View style={{ padding: 14, borderRadius: radii.medium, borderCurve: 'continuous', backgroundColor: colors.canvas, gap: 5 }}><Text style={{ color: colors.ink, fontSize: 13, fontWeight: '800' }}>{title}</Text><Text selectable style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19 }}>{body}</Text></View>;
}

function ProjectMenuItem({
  icon,
  title,
  description,
  destructive = false,
  onPress,
}: {
  icon: Parameters<typeof AppIcon>[0]['name'];
  title: string;
  description: string;
  destructive?: boolean;
  onPress: () => void;
}) {
  const foreground = destructive ? colors.coral : colors.ink;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 68,
        paddingHorizontal: 13,
        borderRadius: 22,
        borderCurve: 'continuous',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: pressed ? (destructive ? colors.coralSoft : colors.canvas) : 'transparent',
      })}
    >
      <View style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: destructive ? colors.coralSoft : colors.canvas }}>
        <AppIcon name={icon} color={foreground} size={20} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: foreground, fontSize: 14, fontWeight: '800' }}>{title}</Text>
        <Text style={{ color: colors.inkMuted, fontSize: 11.5, lineHeight: 16 }}>{description}</Text>
      </View>
      <AppIcon name="chevron-right" color={colors.gray} size={20} />
    </Pressable>
  );
}

function ProgressRow({ current, total, label, detail }: { current: number; total: number; label: string; detail?: string }) {
  const safeTotal = Math.max(1, total);
  const safeCurrent = Math.min(safeTotal, Math.max(0, current));
  const percent = `${Math.round((safeCurrent / safeTotal) * 100)}%` as `${number}%`;
  return (
    <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: safeTotal, now: safeCurrent }} style={{ gap: 7 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: 11.5, fontWeight: '700' }}>{label}</Text>
        <Text style={{ color: colors.blue, fontSize: 11.5, fontWeight: '800' }}>{safeCurrent}/{safeTotal}</Text>
      </View>
      <View style={{ height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.line }}>
        <View style={{ width: percent, height: '100%', borderRadius: 3, backgroundColor: colors.blue }} />
      </View>
      {detail ? <Text numberOfLines={1} style={{ color: colors.inkMuted, fontSize: 10.5 }}>{detail}</Text> : null}
    </View>
  );
}

function adapterLabel(adapter: ExpansionAdapter, profile: ByokProfile | null) {
  if (adapter === 'byok') return profile?.label ?? '个人 AI';
  if (adapter === 'gateway') return 'AI Gateway';
  return '本地模拟器';
}

function adapterStatusLabel(adapter: ExpansionAdapter, profile: ByokProfile | null) {
  if (adapter === 'byok') return profile ? `${profile.label} · ${profile.model}` : '个人 AI 配置不完整';
  if (adapter === 'gateway') return 'AI Gateway 已连接';
  return '未连接 AI';
}

function deepBuildDisclosure(profile: ByokProfile | null) {
  const price = profile?.kind === 'mimo'
    ? 'MiMo 当前普通 API 价格按缓存未命中输入 ¥1/百万 tokens、输出 ¥2/百万 tokens 计算；本 App 的保守上界是三阶段输入合计 360,000 tokens、输出合计 17,000 tokens，最坏约 ¥0.394，实际通常更低。'
    : '费用由你配置的服务商按实际 token 用量计算；请以该服务商当前价目为准。';
  return `将向 ${profile?.label ?? '个人 AI'}（${profile?.model ?? '当前模型'}）依次发送 3 次请求：先形成完整知识底稿，再按你的已知状态重写教学内容，最后编排图谱。相比快速生成会更慢。每阶段输入都有 120,000 UTF-8 字节的本地费用保护上限，输出上限依次为 6,000、6,000、5,000 tokens。${price} 每阶段会立即保存，网络结果不明时绝不自动重试。`;
}

function plainPreview(markdown: string) {
  return markdown.replace(/```[\s\S]*?```/gu, ' [代码] ').replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/^[#>*+-]+\s*/gmu, '').replace(/[*_`~]/gu, '').replace(/\s+/gu, ' ').trim();
}

const focusPresets: { id: FocusPreset; label: string; color: string }[] = [
  { id: 'coral', label: '珊瑚', color: colors.coral },
  { id: 'blue', label: '蓝色', color: colors.blue },
  { id: 'green', label: '绿色', color: colors.green },
  { id: 'amber', label: '琥珀', color: colors.amber },
];

const edgeReviewOptions: { status: EdgeReviewStatus; label: string; color: string }[] = [
  { status: 'unverified', label: '未核验', color: colors.gray },
  { status: 'learner_supported', label: '对我有帮助', color: colors.green },
  { status: 'disputed', label: '有争议', color: colors.amber },
];

const edgeReviewDescription: Record<EdgeReviewStatus, string> = {
  unverified: '这条关系还没有经过你的判断。',
  learner_supported: '你认为它有助于当前理解；这不等于事实已验证。',
  disputed: '你对这条关系存疑，画布会用琥珀色提醒后续复查。',
};

const relationLabel: Record<KnowledgeEdge['relation'], string> = {
  prerequisite: '前置', evidence: '证据', analogy: '类比', support: '支撑', counterexample: '反例', contains: '包含',
};

function EdgeReviewPanel({ edge, disabled, onChange }: { edge: KnowledgeEdge; disabled: boolean; onChange: (status: EdgeReviewStatus) => void }) {
  const selectedOption = edgeReviewOptions.find((option) => option.status === edge.reviewStatus)!;
  return (
    <View accessibilityLabel={`关系判断：${selectedOption.label}；${(edge.label || (edge.relationKind === 'followup' ? '追问' : edge.relationKind === 'related' ? '相关' : relationLabel[edge.relation]))}关系；重要程度 ${edge.importance}`} style={{ borderRadius: radii.large, borderCurve: 'continuous', backgroundColor: 'rgba(255, 252, 247, 0.97)', padding: 14, boxShadow: floatingShadow, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: selectedOption.color }} /><Text style={{ color: colors.ink, fontSize: 13, fontWeight: '800' }}>这条关系对吗？</Text><Text style={{ flex: 1, color: colors.inkMuted, fontSize: 11.5, textAlign: 'right' }}>{(edge.label || (edge.relationKind === 'followup' ? '追问' : edge.relationKind === 'related' ? '相关' : relationLabel[edge.relation]))} · 重要 {edge.importance}</Text></View>
      <Text style={{ color: colors.inkMuted, fontSize: 11.5, lineHeight: 17 }}>{edgeReviewDescription[edge.reviewStatus]}</Text>
      <View style={{ flexDirection: 'row', gap: 7 }}>
        {edgeReviewOptions.map((option) => {
          const active = edge.reviewStatus === option.status;
          return <Pressable key={option.status} accessibilityRole="button" accessibilityState={{ selected: active, disabled }} accessibilityLabel={`标记为${option.label}`} disabled={disabled} onPress={() => onChange(option.status)} style={({ pressed }) => ({ flex: 1, minHeight: 38, borderRadius: radii.small, borderCurve: 'continuous', borderWidth: 1, borderColor: active ? option.color : colors.line, backgroundColor: active ? `${option.color}18` : colors.surfaceStrong, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.55 : pressed ? 0.75 : 1 })}><Text style={{ color: active ? colors.ink : colors.inkMuted, fontSize: 11.5, fontWeight: active ? '800' : '600' }}>{option.label}</Text></Pressable>;
        })}
      </View>
    </View>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} /><Text style={{ color: colors.inkMuted, fontSize: 10.5 }}>{label}</Text></View>;
}
