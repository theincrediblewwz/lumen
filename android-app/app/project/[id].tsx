import {exportRichBoard} from '@/data/rich-board-files';
import {WorkspaceButton} from '@/components/workspace-controls';
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
import { AutoGrowingInput } from '@/components/auto-growing-input';
import { CanvasIconButton, CanvasSelectionCard, canvasControlStyles } from '@/components/canvas-controls';
import { FloatingButton } from '@/components/floating-button';
import { KnowledgeCanvas, type FocusPreset } from '@/components/knowledge-canvas';
import { NodeDocumentCards } from '@/components/node-document-cards';
import { visibleCanvasIds } from '@/components/canvas-visibility';
import { getCanvasState, rememberBoard, saveCanvasViewport, saveCollapsedNodes, type CanvasViewport } from '@/data/canvas-state';
import { addCanvasGroupMember, createCanvasGroup, deleteCanvasGroup, listCanvasGroups, moveCanvasGroup, removeCanvasGroupMember, renameCanvasGroup, undoCanvasGroupChange, type CanvasGroup, type CanvasGroupMember, type CanvasGroupUndo } from '@/data/canvas-groups';
import { connectNodes, disconnectNodes, listNodeDocuments, moveNode, restoreDisconnectedNodes } from '@/data/node-workspace';
import { createConversation, listConversations } from '@/data/conversations';
import { onSyncUpdate } from '@/sync/runtime';
import { pickAndExportProject, type ExportProgress } from '@/data/android-folder-transfer';
import type { ExpansionAdapter } from '@/data/expansion-jobs';
import { getLatestExpansionJobForProject } from '@/data/expansion-jobs';
import {
  deleteKnowledgeNode,
  deleteProject,
  getGraph,
  getLatestAppliedGraphMutationBatch,
  getNodeDeleteImpact,
  reflowProjectGraph,
  type NodeDeleteImpact,
  undoGraphMutationBatch,
} from '@/data/knowledge-repository';
import { listNodeAnswers } from '@/data/node-answers';
import {
  FavoriteDependencyError,
} from '@/data/personal-context';
import { listPromptTemplates, savePromptTemplate } from '@/data/prompt-templates';
import { colors, floatingShadow, radii } from '@/theme/tokens';
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode, MarkdownDocument, PromptTemplate } from '@/types/domain';

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
  const loadedCanvasState = useRef(false);
  const lastGraph = useRef<KnowledgeGraph | null>(null);
  const collapsedIdsRef = useRef<string[]>([]);
  const viewportWrites = useRef<Promise<void>>(Promise.resolve());
  const [canvasStateReady, setCanvasStateReady] = useState(false);
  const [initialViewport, setInitialViewport] = useState<CanvasViewport | null>(null);
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<string[]>([]);
  const [localFocusId, setLocalFocusId] = useState<string | null>(null);
  const [restoreViewport, setRestoreViewport] = useState<CanvasViewport | null>(null);
  const [restoreRequest, setRestoreRequest] = useState(0);
  const [jumpFocusNodeId, setJumpFocusNodeId] = useState<string | null>(null);
  const beforeFocusViewport = useRef<CanvasViewport | null>(null);
  const currentViewport = useRef<CanvasViewport | null>(null);
  const [boardUnavailable, setBoardUnavailable] = useState(false);
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [selected, setSelected] = useState<KnowledgeNode | KnowledgeEdge | null>(null);
  const [nodeDocuments, setNodeDocuments] = useState<MarkdownDocument[]>([]);
  const [prompt, setPrompt] = useState('');
  const [expanding, setExpanding] = useState(false);
  const [expansionQuality, setExpansionQuality] = useState<ExpansionQualityPath>('quick');
  const [deepProgress, setDeepProgress] = useState<DeepBuildProgress | null>(null);
  const [preparingPreview, setPreparingPreview] = useState(false);
  const [expansionAdapter, setExpansionAdapter] = useState<ExpansionAdapter>('local');
  const [byokProfile, setByokProfile] = useState<ByokProfile | null>(null);
  const [jobWarning, setJobWarning] = useState<string | null>(null);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [answerCount, setAnswerCount] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [localDataVisible, setLocalDataVisible] = useState(false);
  const [projectMenuVisible, setProjectMenuVisible] = useState(false);
  const [canvasViewVisible, setCanvasViewVisible] = useState(false);
  const [boardMoreVisible, setBoardMoreVisible] = useState(false);
  const [movingNodeId, setMovingNodeId] = useState<string | null>(null);
  const [connectingNodeId, setConnectingNodeId] = useState<string | null>(null);
  const [canvasGroups, setCanvasGroups] = useState<CanvasGroup[]>([]);
  const [canvasGroupMembers, setCanvasGroupMembers] = useState<CanvasGroupMember[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [groupPickMode, setGroupPickMode] = useState<{ kind: 'create' } | { kind: 'add'; groupId: string } | null>(null);
  const [groupPickIds, setGroupPickIds] = useState<string[]>([]);
  const [groupNameDialog, setGroupNameDialog] = useState<'create' | 'rename' | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState('');
  const [groupUndo, setGroupUndo] = useState<CanvasGroupUndo | null>(null);
  const [movingGroupId, setMovingGroupId] = useState<string | null>(null);
  const groupMoveBase = useRef<Record<string, { x: number; y: number }>>({});
  const [expansionVisible, setExpansionVisible] = useState(false);
  const [expansionOptionsVisible, setExpansionOptionsVisible] = useState(false);
  const [edgeReviewVisible, setEdgeReviewVisible] = useState(false);
  const expansionDrafts = useRef<Record<string, string>>({});
  const [fitRequest, setFitRequest] = useState(0);
  const [focusRequest, setFocusRequest] = useState(0);
  const [actionNode, setActionNode] = useState<KnowledgeNode | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<NodeDeleteImpact | null>(null);
  const [nodeFocusPresets, setNodeFocusPresets] = useState<Record<string, FocusPreset>>({});

  useEffect(() => {
    setGroupUndo(null); setSelectedGroupId(null); setGroupPickMode(null); setGroupPickIds([]);
    setMovingGroupId(null);
  }, [id]);

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
    const [nextGraph, latestJob, groupState] = await Promise.all([getGraph(db, id), getLatestExpansionJobForProject(db, id), listCanvasGroups(db, id)]);
    if (!nextGraph) { setBoardUnavailable(true); return; }
    if (!loadedCanvasState.current) {
      loadedCanvasState.current = true;
      const saved = await getCanvasState(db, id).catch(() => ({ viewport: null, collapsedNodeIds: [] }));
      setInitialViewport(saved.viewport);
      currentViewport.current = saved.viewport;
      collapsedIdsRef.current = saved.collapsedNodeIds.filter(nodeId => nextGraph.nodes.some(node => node.id === nodeId));
      setCollapsedNodeIds(collapsedIdsRef.current);
      setCanvasStateReady(true);
    }
    const added = lastGraph.current?.project.id === id
      ? nextGraph.nodes.find(node => !lastGraph.current?.nodes.some(previous => previous.id === node.id)) : null;
    if (added && !visibleCanvasIds(nextGraph.nodes, nextGraph.edges, collapsedIdsRef.current).has(added.id)) {
      collapsedIdsRef.current = [];
      setCollapsedNodeIds([]);
      void saveCollapsedNodes(db, id, []).catch(() => undefined);
      setLocalFocusId(null);
      setJumpFocusNodeId(added.id);
      setSelected(added);
      setFocusRequest(value => value + 1);
    }
    lastGraph.current = nextGraph;
    void rememberBoard(db, id).catch(() => undefined);
    setGraph(nextGraph);
    setCanvasGroups(groupState.groups);
    setCanvasGroupMembers(groupState.members);
    setSelectedGroupId(current => groupState.groups.some(group => group.id === current) ? current : null);
    setJobWarning(latestJob?.status === 'failed' ? latestJob.errorMessage ?? '最近一次 AI 回答失败；不会自动重试。' : null);
    setSelected((current) => {
      if (!nextGraph) return null;
      const refreshed = current
        ? nextGraph.nodes.find((item) => item.id === current.id) ?? nextGraph.edges.find((item) => item.id === current.id)
        : null;
      return refreshed ?? null;
    });
  }, [db, id]);

  useEffect(() => { if (boardUnavailable) router.replace('/'); }, [boardUnavailable]);

  useFocusEffect(useCallback(() => { void loadGraph().catch(() => setJobWarning('无法读取图谱，请重新打开。')); }, [loadGraph]));
  useEffect(()=>onSyncUpdate(()=>{if(!movingNodeId)void loadGraph().catch(()=>undefined);}),[loadGraph,movingNodeId]);

  useEffect(() => {
    if (!graph || !initialNodeId) return;
    const focusKey=`${id}:${initialNodeId}`;
    if (initialFocusFor.current===focusKey) return;
    const target = graph.nodes.find((node) => node.id === initialNodeId);
    if (!target) return;
    initialFocusFor.current=focusKey;
    if (!visibleCanvasIds(graph.nodes, graph.edges, collapsedNodeIds).has(target.id)) {
      collapsedIdsRef.current = [];
      setCollapsedNodeIds([]);
      void saveCollapsedNodes(db, id!, []).catch(() => undefined);
    }
    setLocalFocusId(null);
    setJumpFocusNodeId(target.id);
    setSelected(target);
    setFocusRequest((current) => current + 1);
  }, [graph, id, initialNodeId, collapsedNodeIds, db]);

  const visibleIds = useMemo(() => graph
    ? visibleCanvasIds(graph.nodes, graph.edges, collapsedNodeIds, localFocusId)
    : new Set<string>(), [graph, collapsedNodeIds, localFocusId]);
  const visibleNodes = useMemo(() => graph?.nodes.filter(node => visibleIds.has(node.id)) ?? [], [graph, visibleIds]);
  const visibleEdges = useMemo(() => graph?.edges.filter(edge => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId)) ?? [], [graph, visibleIds]);

  const onViewportChange = useCallback((viewport: CanvasViewport) => {
    if (!id) return;
    currentViewport.current = viewport;
    viewportWrites.current = viewportWrites.current.catch(() => undefined).then(() => saveCanvasViewport(db, id, viewport));
  }, [db, id]);

  const toggleLocalFocus = useCallback((nodeId: string) => {
    setActionNode(null);
    if (localFocusId) {
      setLocalFocusId(null);
      if (beforeFocusViewport.current) {
        setRestoreViewport(beforeFocusViewport.current);
        setRestoreRequest(value => value + 1);
      }
      beforeFocusViewport.current = null;
      return;
    }
    beforeFocusViewport.current = currentViewport.current;
    setJumpFocusNodeId(null);
    setLocalFocusId(nodeId);
    setSelected(null);
    setFocusRequest(value => value + 1);
  }, [localFocusId]);

  const selectedNode = useMemo(() => (selected && 'status' in selected ? selected : null), [selected]);
  const selectedNodeId = selectedNode?.id;
  const selectedEdge = useMemo(() => (selected && 'reviewStatus' in selected ? selected : null), [selected]);
  const selectedId = selected?.id ?? null;
  const selectedFocusPreset = selectedNode ? nodeFocusPresets[selectedNode.id] ?? 'coral' : 'coral';

  useEffect(() => {
    setExpansionVisible(false);
    setEdgeReviewVisible(!selectedNodeId && Boolean(selectedId));
    setPrompt(selectedNodeId ? expansionDrafts.current[selectedNodeId] ?? '' : '');
  }, [selectedId, selectedNodeId]);

  const updatePrompt = (value: string) => {
    if (selectedNode) expansionDrafts.current[selectedNode.id] = value;
    setPrompt(value);
  };

  useFocusEffect(useCallback(() => {
    if (!selectedNodeId) {
      setNodeDocuments([]);
      return;
    }
    let active = true;
    listNodeDocuments(db, selectedNodeId)
      .then((value) => { if (active) setNodeDocuments(value); })
      .catch(() => { if (active) setNodeDocuments([]); });
    return () => { active = false; };
  }, [db, selectedNodeId]));

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
    setConnectingNodeId(null);
    setExpansionVisible(false);
    setEdgeReviewVisible(false);
    setSelected(null);
    setSelectedGroupId(null);
  }, []);

  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (groupNameDialog) { setGroupNameDialog(null); return true; }
      if (connectingNodeId) { setConnectingNodeId(null); return true; }
      if (groupPickMode) { setGroupPickMode(null); setGroupPickIds([]); return true; }
      if (movingGroupId) { setMovingGroupId(null); setMovingNodeId(null); void loadGraph(); return true; }
      if (movingNodeId) { setMovingNodeId(null); return true; }
      if (expansionVisible || edgeReviewVisible) {
        Keyboard.dismiss(); setExpansionVisible(false); setEdgeReviewVisible(false); return true;
      }
      if (selected || selectedGroupId) { clearSelection(); return true; }
      return false;
    });
    return () => subscription.remove();
  }, [clearSelection, connectingNodeId, edgeReviewVisible, expansionVisible, groupNameDialog, groupPickMode, loadGraph, movingGroupId, movingNodeId, selected, selectedGroupId]));

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
      try {
        await loadGraph();
      } catch (refreshError) {
        const detail = refreshError instanceof Error ? refreshError.message : '请重新打开白板';
        Alert.alert('回答和新节点已保存', `白板暂时未能刷新：${detail}。重新打开白板即可查看。`);
        return;
      }
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
      void loadGraph().catch(() => undefined);
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

  const exportRich=async(desktop=false)=>{if(exporting||!graph)return;setExporting(true);try{const result=await exportRichBoard(db,graph.project.id,desktop,label=>setExportProgress({current:4,total:8,label}));if(result)Alert.alert('导出完成',`${result.name}\n已保留${result.originals}份原件。${result.missing?`旧来源另有${result.missing}份原件在本机缺失。`:''}`);}catch(e){Alert.alert('导出失败',e instanceof Error?e.message:'尚未完成');}finally{setExporting(false);}};
  const exportProject = async () => {
    if (!graph || exporting) return;
    setExporting(true);
    setExportProgress({ current: 1, total: 8, label: '准备导出' });
    try {
      const result = await pickAndExportProject(db, graph.project.id, setExportProgress);
      if (!result) {
        setExportProgress(null);
        return;
      }
      Alert.alert('导出完成', `${result.directoryName}\n\n包含 ${result.documentCount} 份 Markdown、${result.sourceCount} 份资料、${result.assetCount} 份已校验原件、${result.masteryAttemptCount} 次掌握记录和 ${result.answerCount} 条已收藏回答。${result.missingAssetCount ? `本机另有 ${result.missingAssetCount} 份旧来源原件缺失，只保留提取文本。` : ''}请保留整个文件夹。`);
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
    getNodeDeleteImpact(db, node.id)
      .then(setDeleteImpact)
      .catch((error) => Alert.alert('无法读取节点信息', error instanceof Error ? error.message : '请稍后重试'));
  }, [db]);

  const openNodeDiscussion = async (node: KnowledgeNode) => {
    setActionNode(null);
    try {
      const existing = await listConversations(db, node.projectId, node.id);
      const conversationId = existing[0]?.id ?? await createConversation(db, node.projectId, node.id, `关于 ${node.title}`);
      router.push({ pathname: '/discussion', params: { conversationId } });
    } catch (error) {
      Alert.alert('无法打开对话', error instanceof Error ? error.message : '请稍后重试');
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
      `会删除这个节点、${impact.edgeCount} 条相关连线、${impact.answerCount} 条回答及 ${impact.reviewEventCount} 条复习记录。其他节点和仍被使用的文档会保留。此操作无法撤销。`,
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

  const confirmDisconnectConnection = () => {
    if (!selectedEdge || !graph) return;
    const edge = selectedEdge;
    Alert.alert('解除这条连接？', '只移除节点之间的线，节点、文档和对话都会保留。', [
      { text: '取消', style: 'cancel' },
      { text: '解除连接', style: 'destructive', onPress: () => {
        void disconnectNodes(db, graph.project.id, edge.id)
          .then(async removed => {
            setSelected(null);
            await loadGraph();
            Alert.alert('连接已解除', '节点和文档仍在原处。', [
              { text: '完成' },
              { text: '撤销', onPress: () => void restoreDisconnectedNodes(db, removed).then(loadGraph).catch(error => Alert.alert('无法恢复连接', error instanceof Error ? error.message : '请稍后重试')) },
            ]);
          })
          .catch(error => Alert.alert('连接没有解除', error instanceof Error ? error.message : '请稍后重试'));
      } },
    ]);
  };

  const applyGroupOperation = async (operation: Promise<CanvasGroupUndo>, done?: () => void) => {
    try {
      const undo = await operation;
      setGroupUndo(undo);
      done?.();
      await loadGraph();
    } catch (error) {
      Alert.alert('分组没有更新', error instanceof Error ? error.message : '请稍后重试');
      await loadGraph().catch(() => undefined);
    }
  };

  const selectCanvasNode = (node: KnowledgeNode) => {
    if (connectingNodeId) {
      if (node.id === connectingNodeId) return;
      void connectNodes(db, id!, connectingNodeId, node.id)
        .then(async () => {
          setConnectingNodeId(null);
          try { await loadGraph(); setSelected(node); }
          catch { Alert.alert('连线已保存', '白板暂时未能刷新，重新打开即可查看。'); }
        })
        .catch(error => Alert.alert('连线未建立', error instanceof Error ? error.message : '请重试'));
      return;
    }
    if (groupPickMode?.kind === 'create') {
      if (canvasGroupMembers.some(member => member.node_id === node.id)) return Alert.alert('节点已有分组', '先在原分组中移出这个节点。');
      setGroupPickIds(current => current.includes(node.id) ? current.filter(value => value !== node.id) : [...current, node.id]);
      return;
    }
    if (groupPickMode?.kind === 'add') {
      if (canvasGroupMembers.some(member => member.node_id === node.id)) return Alert.alert('节点已有分组', '先在原分组中移出这个节点。');
      void applyGroupOperation(addCanvasGroupMember(db, id!, groupPickMode.groupId, node.id), () => setGroupPickMode(null));
      return;
    }
    setSelectedGroupId(null);
    setSelected(node);
  };

  const saveGroupName = async () => {
    if (!id) return;
    if (groupNameDialog === 'create') {
      try {
        const created = await createCanvasGroup(db, id, groupNameDraft, groupPickIds);
        setGroupUndo(created.undo); setSelectedGroupId(created.groupId);
        setGroupNameDialog(null); setGroupPickMode(null); setGroupPickIds([]); setGroupNameDraft('');
        await loadGraph();
      } catch (error) { Alert.alert('无法创建分组', error instanceof Error ? error.message : '请稍后重试'); }
    } else if (groupNameDialog === 'rename' && selectedGroupId) {
      await applyGroupOperation(renameCanvasGroup(db, id, selectedGroupId, groupNameDraft), () => setGroupNameDialog(null));
    }
  };

  const startMoveGroup = (groupId: string) => {
    if (!graph) return;
    const ids = canvasGroupMembers.filter(member => member.group_id === groupId).map(member => member.node_id);
    const anchor = graph.nodes.find(node => ids.includes(node.id));
    if (!anchor) return Alert.alert('分组已为空', '请重新打开白板。');
    groupMoveBase.current = Object.fromEntries(graph.nodes.filter(node => ids.includes(node.id)).map(node => [node.id, { x: node.x, y: node.y }]));
    setMovingGroupId(groupId); setMovingNodeId(anchor.id); setSelectedGroupId(null);
  };

  const previewMove = (nodeId: string, x: number, y: number) => {
    if (movingGroupId) {
      const anchor = groupMoveBase.current[nodeId];
      if (!anchor) return;
      const dx = x - anchor.x; const dy = y - anchor.y;
      setGraph(current => current ? { ...current, nodes: current.nodes.map(node => {
        const base = groupMoveBase.current[node.id]; return base ? { ...node, x: base.x + dx, y: base.y + dy } : node;
      }) } : current);
    } else setGraph(current => current ? { ...current, nodes: current.nodes.map(node => node.id === nodeId ? { ...node, x, y } : node) } : current);
  };

  const finishMove = (nodeId: string, x: number, y: number) => {
    if (movingGroupId) {
      const anchor = groupMoveBase.current[nodeId];
      const groupId = movingGroupId;
      setMovingGroupId(null); setMovingNodeId(null);
      if (anchor) void applyGroupOperation(moveCanvasGroup(db, id!, groupId, x - anchor.x, y - anchor.y));
    } else void moveNode(db, nodeId, x, y).catch(error => { Alert.alert('位置未保存', error.message); void loadGraph(); });
  };

  if (!graph || !canvasStateReady) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas }}><ActivityIndicator color={colors.ink} /></View>;

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
        nodes={visibleNodes}
        edges={visibleEdges}
        groups={canvasGroups}
        groupMembers={canvasGroupMembers}
        selectedGroupId={selectedGroupId}
        pickingNodeIds={groupPickIds}
        onSelectGroup={groupId => { if (!groupPickMode) { setSelected(null); setSelectedGroupId(groupId); } }}
        selectedId={groupPickMode ? null : selectedId}
        focusPreset={selectedFocusPreset}
        onSelectNode={selectCanvasNode}
        onSelectEdge={edge => { if (!groupPickMode) { setSelectedGroupId(null); setSelected(edge); } }}
        onClearSelection={clearSelection}
        movingNodeId={movingNodeId}
        onPreviewMove={previewMove}
        onMoveNode={finishMove}
        fitRequest={fitRequest}
        focusNodeId={localFocusId ?? jumpFocusNodeId}
        focusRequest={focusRequest}
        initialViewport={initialViewport}
        restoredViewport={restoreViewport}
        restoreRequest={restoreRequest}
        onViewportChange={onViewportChange}
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

      {(localFocusId || collapsedNodeIds.length > 0) && !movingNodeId ? <View style={[canvasControlStyles.floating, { position: 'absolute', left: 16, bottom: insets.bottom + 20, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
        <Text style={{ color: colors.inkMuted, fontSize: 12 }}>{localFocusId ? '局部查看' : `已折叠 ${collapsedNodeIds.length} 支`}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="显示全部节点" onPress={() => {
          if (localFocusId) toggleLocalFocus(localFocusId);
          collapsedIdsRef.current = [];
          setCollapsedNodeIds([]);
          void saveCollapsedNodes(db, id!, []).catch(() => undefined);
        }}><Text style={{ color: colors.blue, fontSize: 12, fontWeight: '800' }}>全部显示</Text></Pressable>
      </View> : null}

      {!selected && !selectedGroupId && !groupPickMode && !movingNodeId ? <View style={[canvasControlStyles.floating, { position: 'absolute', right: 16, bottom: insets.bottom + 20 }]}>
        <CanvasIconButton icon="add" label="新建节点" onPress={() => router.push({ pathname: '/new-node', params: { projectId: id! } })} />
      </View> : null}

      {expanding && !expansionVisible ? <View accessibilityLiveRegion="polite" style={[canvasControlStyles.floating, { position: 'absolute', top: insets.top + 74, alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 9, flexDirection: 'row', gap: 8, alignItems: 'center' }]}>
        <ActivityIndicator size="small" color={colors.blue} /><Text style={{ color: colors.inkMuted, fontSize: 12 }}>正在扩展图谱…</Text>
      </View> : null}

      {groupUndo && !groupPickMode && !movingNodeId ? <View style={[canvasControlStyles.floating, { position: 'absolute', top: insets.top + 70, right: 16, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
        <Text style={{ color: colors.inkMuted, fontSize: 12 }}>分组已保存</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="撤销最近一次分组操作" onPress={() => { void undoCanvasGroupChange(db, groupUndo).then(async () => { setGroupUndo(null); await loadGraph(); }).catch(error => { setGroupUndo(null); Alert.alert('无法撤销', error instanceof Error ? error.message : '请稍后重试'); void loadGraph(); }); }}><Text style={{ color: colors.blue, fontWeight: '800' }}>撤销</Text></Pressable>
      </View> : null}

      {groupPickMode && !movingNodeId ? <View style={[canvasControlStyles.floating, { position: 'absolute', left: 14, right: 14, bottom: insets.bottom + 12, padding: 16, gap: 10 }]}>
        <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '700' }}>{groupPickMode.kind === 'create' ? `点选要放在一起的节点 · 已选 ${groupPickIds.length}` : '点选一个未分组节点，加入当前分组'}</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <SheetButton label="取消" onPress={() => { setGroupPickMode(null); setGroupPickIds([]); }} />
          {groupPickMode.kind === 'create' ? <SheetButton label="命名分组" tone="blue" onPress={() => { if (groupPickIds.length < 2) return Alert.alert('至少选择两个节点'); setGroupNameDraft(''); setGroupNameDialog('create'); }} /> : null}
        </View>
      </View> : null}

      {selectedGroupId && !groupPickMode && !movingNodeId ? <View style={{ position: 'absolute', left: 14, right: 14, bottom: insets.bottom + 12, maxHeight: safeFrame.height * 0.53 }}>
        <ScrollView style={[canvasControlStyles.floating, { padding: 16 }]} contentContainerStyle={{ gap: 10, paddingBottom: 18 }}>
          <Text style={{ color: colors.ink, fontSize: 17, fontWeight: '800' }}>{canvasGroups.find(group => group.id === selectedGroupId)?.title ?? '分组'}</Text>
          <Text style={{ color: colors.inkMuted, fontSize: 12 }}>整理白板的分组；不会改变学习关系</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <SheetButton label="改名" onPress={() => { setGroupNameDraft(canvasGroups.find(group => group.id === selectedGroupId)?.title ?? ''); setGroupNameDialog('rename'); }} />
            <SheetButton label="移动整组" tone="blue" onPress={() => startMoveGroup(selectedGroupId)} />
            <SheetButton label="加入节点" onPress={() => { setGroupPickMode({ kind: 'add', groupId: selectedGroupId }); setSelectedGroupId(null); }} />
          </View>
          {canvasGroupMembers.filter(member => member.group_id === selectedGroupId).map(member => <View key={member.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: 13 }}>{graph.nodes.find(node => node.id === member.node_id)?.title ?? '节点已移除'}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={`从分组移出${graph.nodes.find(node => node.id === member.node_id)?.title ?? '节点'}`} onPress={() => void applyGroupOperation(removeCanvasGroupMember(db, id!, selectedGroupId, member.node_id))} style={{ padding: 8 }}><Text style={{ color: colors.blue, fontSize: 12 }}>移出</Text></Pressable>
          </View>)}
          <SheetButton label="取消分组（保留所有节点）" onPress={() => Alert.alert('取消这个分组？', '仅解除分组，节点、文档、关系和对话都会保留。', [{ text: '保留', style: 'cancel' }, { text: '取消分组', onPress: () => void applyGroupOperation(deleteCanvasGroup(db, id!, selectedGroupId)) }])} />
          <SheetButton label="关闭" onPress={() => setSelectedGroupId(null)} />
        </ScrollView>
      </View> : null}

      {connectingNodeId ? <View style={[canvasControlStyles.floating, { position: 'absolute', left: 14, right: 14, bottom: insets.bottom + 12, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
        <Text style={{ flex: 1, color: colors.ink }}>点选另一个节点，建立一条关联线</Text>
        <SmallAction icon="close" label="取消" onPress={() => setConnectingNodeId(null)} />
      </View> : null}
      {selected && !connectingNodeId && !groupPickMode && !movingNodeId && !expansionVisible ? <View style={{ position: 'absolute', left: 14, right: 14, bottom: insets.bottom + 12, maxHeight: safeFrame.height * 0.7 }}>
          <CanvasSelectionCard title={selectedNode?.title || selectedEdge?.label || '关系'} onClose={clearSelection}>
            <View style={{ flexDirection: 'row', gap: 4 }}>
              {selectedNode ? <>
                <SmallAction icon="smart-toy" label="问 AI" onPress={() => setExpansionVisible(true)} />
                <SmallAction icon="device-hub" label="连线" onPress={() => setConnectingNodeId(selectedNode.id)} />
                <SmallAction icon="more-horiz" label="更多" onPress={() => openNodeActions(selectedNode)} />
              </> : <SmallAction icon="link" label="查看连接" onPress={() => setEdgeReviewVisible(current => !current)} />}
            </View>
            {selectedNode && nodeDocuments.length ? <ScrollView style={{ maxHeight: safeFrame.height * 0.36 }} showsVerticalScrollIndicator={false}>
              <NodeDocumentCards compact documents={nodeDocuments} onOpen={documentId => router.push({ pathname: '/document/[id]', params: { id: documentId } })} />
            </ScrollView> : null}
            {selectedEdge && edgeReviewVisible ? <View style={{ padding: 12, gap: 9 }}>
              <Text style={{ color: colors.ink, fontSize: 13 }}>{graph.nodes.find(node => node.id === selectedEdge.sourceId)?.title ?? '起点'} → {graph.nodes.find(node => node.id === selectedEdge.targetId)?.title ?? '终点'}</Text>
              <SheetButton label="解除连接" onPress={confirmDisconnectConnection} />
            </View> : null}
          </CanvasSelectionCard>
      </View> : null}

      {movingNodeId ? <View style={{position:'absolute',left:16,right:16,bottom:24+insets.bottom,padding:16,backgroundColor:colors.surfaceStrong,borderRadius:20,gap:10}}><Text style={{color:colors.ink}}>拖动屏幕{movingGroupId ? '移动整组' : '放置节点'}，位置会自动保存。</Text><Pressable accessibilityRole="button" onPress={()=>{setMovingNodeId(null);setMovingGroupId(null);void loadGraph();}} style={{padding:14,backgroundColor:colors.blueSoft,borderRadius:18}}><Text style={{color:colors.blue,textAlign:'center'}}>完成移动</Text></Pressable></View> : null}
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
        <View style={{ flexShrink: 0, borderRadius: radii.large, borderCurve: 'continuous', backgroundColor: colors.surfaceStrong, padding: 10, gap: 8, boxShadow: floatingShadow }}>
          <View>
            <AutoGrowingInput value={prompt} onChangeText={updatePrompt} editable={Boolean(selectedNode) && !expanding} accessibilityLabel="向这个节点提问" placeholder="向这个节点提问…" minHeight={96} maxHeight={210} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: expansionOptionsVisible }} onPress={() => setExpansionOptionsVisible(value => !value)} style={{ flex: 1, minHeight: 48, justifyContent: 'center', paddingHorizontal: 12 }}><Text style={{ color: colors.inkMuted, fontSize: 13 }}>{expansionOptionsVisible ? '收起选项' : '生成选项'}</Text></Pressable>
            <FloatingButton accessibilityLabel={expanding ? '模型正在回答' : '发送问题并保存文档'} icon="arrow-upward" onPress={expand} tone="dark" disabled={!selectedNode || expanding || !prompt.trim()} loading={expanding} />
          </View>
          {expansionOptionsVisible ? (
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
              <SmallAction icon="bookmark-add" label="存为模板" onPress={saveCurrentPrompt} />
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
            </View>
            <ProjectMenuItem icon="add" title="新建节点" description="写一篇文档，连接自己的想法" onPress={()=>{setProjectMenuVisible(false);router.push({pathname:'/new-node',params:{projectId:id!,...(selectedNode?{parentId:selectedNode.id}:{})}});}}/>
            <ProjectMenuItem icon="forum" title="图谱讨论" description="查看连续对话，把有用的内容保存为节点" onPress={()=>{setProjectMenuVisible(false);router.push({pathname:'/discussion',params:{projectId:id!}});}}/>
            <ProjectMenuItem icon="search" title="搜索图谱内容" description="查找文档、资料和对话原文" onPress={()=>{setProjectMenuVisible(false);router.push({pathname:'/search',params:{projectId:id!}});}}/>
            <ProjectMenuItem icon="filter-center-focus" title="画布视图" description="回到全图、整理位置或改变展开方向" onPress={() => setCanvasViewVisible(value => !value)} />
            {canvasViewVisible ? <>
              <ProjectMenuItem icon="filter-center-focus" title="回到全图" description="展开所有节点并适配白板" onPress={() => { setProjectMenuVisible(false); setLocalFocusId(null); setJumpFocusNodeId(null); collapsedIdsRef.current = []; setCollapsedNodeIds([]); void saveCollapsedNodes(db, id!, []).catch(() => undefined); setFitRequest(current => current + 1); }} />
              <ProjectMenuItem icon="account-tree" title="整理并居中" description="重新排列节点并显示完整白板" onPress={() => { setProjectMenuVisible(false); void arrangeGraph(); }} />
              <ProjectMenuItem icon="swap-horiz" title={graph.project.layoutDirection === 'vertical' ? '横向展开' : '纵向展开'} description="调整节点层级方向" onPress={() => { setProjectMenuVisible(false); void switchLayoutDirection(); }} />
            </> : null}
            <ProjectMenuItem
              icon="tune"
              title="白板资料与 AI 讲解"
              description="资料来源、知识库引用与 AI 讲解方式"
              onPress={() => {
                setProjectMenuVisible(false);
                router.push({ pathname: '/project-settings', params: { projectId: graph.project.id } });
              }}
            />
            <ProjectMenuItem icon="settings" title="应用与同步设置" description="AI 连接、跨设备同步、备份与其他设置" onPress={() => { setProjectMenuVisible(false); router.push('/settings'); }} />
            <ProjectMenuItem icon="folder" title="引用我的知识库" description="选择理解、经验与材料；每块白板单独授权" onPress={() => { setProjectMenuVisible(false); router.push({ pathname: '/knowledge-library', params: { projectId: graph.project.id, ...(selectedNode ? { nodeId: selectedNode.id } : {}) } }); }} />
            <ProjectMenuItem icon="more-horiz" title="更多白板操作" description="分组、移动、导出及撤销" onPress={() => setBoardMoreVisible(value => !value)} />
            {boardMoreVisible ? <>
            <ProjectMenuItem icon="create-new-folder" title="创建分组" description="点选至少两个节点后命名" onPress={() => { setProjectMenuVisible(false); setSelected(null); setSelectedGroupId(null); setGroupPickIds([]); setGroupPickMode({ kind: 'create' }); }} />
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
              description="选择文件夹，导出文档、图结构、收藏回答与本机原件"
              onPress={() => {
                setProjectMenuVisible(false);
                setLocalDataVisible(true);
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
            </> : null}
          </ScrollView></Pressable>
        </Pressable>
      </Modal>

      <Modal visible={Boolean(groupNameDialog)} transparent animationType="fade" onRequestClose={() => setGroupNameDialog(null)}>
        <Pressable onPress={() => setGroupNameDialog(null)} style={{ flex: 1, justifyContent: 'center', backgroundColor: 'rgba(32,32,31,0.28)', padding: 20 }}>
          <Pressable onPress={() => undefined} style={{ backgroundColor: colors.surfaceStrong, borderRadius: 24, padding: 20, gap: 14 }}>
            <Text style={{ color: colors.ink, fontSize: 18, fontWeight: '800' }}>{groupNameDialog === 'create' ? '命名分组' : '修改分组名称'}</Text>
            <TextInput accessibilityLabel="分组名称" value={groupNameDraft} onChangeText={setGroupNameDraft} maxLength={80} autoFocus placeholder="例如：核心概念" style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 13, padding: 12, color: colors.ink }} />
            <View style={{ flexDirection: 'row', gap: 8 }}><SheetButton label="取消" onPress={() => setGroupNameDialog(null)} /><SheetButton label="保存" tone="blue" onPress={() => void saveGroupName()} /></View>
          </Pressable>
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
            <SheetButton label="管理文档与排序" onPress={() => { const nodeId = actionNode!.id; setActionNode(null); router.push({ pathname: '/node-documents', params: { nodeId } }); }} />
            <SheetButton label="继续对话" onPress={() => void openNodeDiscussion(actionNode!)} />
            <SheetButton label={`回答记录 · ${answerCount}`} onPress={() => { const node = actionNode!; setActionNode(null); router.push({ pathname: '/node-answers', params: { nodeId: node.id, title: node.title } }); }} />
            <SheetButton label="添加子节点" onPress={()=>{const parentId=actionNode!.id;setActionNode(null);router.push({pathname:'/new-node',params:{projectId:id!,parentId}});}}/>
            <SheetButton label="移动节点（备用）" onPress={()=>{setMovingNodeId(actionNode!.id);setActionNode(null);}}/>
            <SheetButton label={localFocusId ? '回到全图' : '聚焦这一支'} onPress={() => toggleLocalFocus(actionNode!.id)} />
            <View style={{ gap: 9 }}>
              <Text style={{ color: colors.ink, fontSize: 12.5, fontWeight: '800' }}>醒目边框预设（仅当前使用会话）</Text>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                {focusPresets.map((item) => {
                  const active = actionNode ? (nodeFocusPresets[actionNode.id] ?? 'coral') === item.id : false;
                  return <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={`${item.label}高亮边框`} onPress={() => actionNode && setNodeFocusPresets((current) => ({ ...current, [actionNode.id]: item.id }))} style={({ pressed }) => ({ width: 46, height: 46, borderRadius: 23, borderWidth: active ? 5 : 2, borderColor: item.color, backgroundColor: `${item.color}20`, opacity: pressed ? 0.7 : 1 })} />;
                })}
              </View>
            </View>
            <View style={{ height: 1, backgroundColor: colors.line }} />
            <Pressable accessibilityRole="button" disabled={!deleteImpact || deleteImpact.isRoot || deleteImpact.activeJobCount > 0} onPress={confirmDeleteNode} style={({ pressed }) => ({ minHeight: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.coralSoft, opacity: !deleteImpact || deleteImpact.isRoot || deleteImpact.activeJobCount > 0 ? 0.45 : pressed ? 0.72 : 1 })}>
              <Text style={{ color: colors.coral, fontWeight: '800' }}>{deleteImpact?.isRoot ? '根目标请在项目设置中删除' : deleteImpact?.activeJobCount ? 'AI 回答结束后才能删除' : '删除这个节点'}</Text>
            </Pressable>
          </ScrollView>
          </Pressable>
        </Pressable>
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
                  <Text style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19 }}>创建 Markdown、完整图结构、已收藏回答和本机可读原件；不会把目标文件夹当成实时工作区。</Text>
                </View>
                {exportProgress ? <ProgressRow current={exportProgress.current} total={exportProgress.total} label={exportProgress.label} detail={exportProgress.detail} /> : null}
                <Pressable disabled={exporting} onPress={() => void exportProject()} style={({ pressed }) => ({ minHeight: 50, borderRadius: 25, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center', opacity: exporting ? 0.5 : pressed ? 0.8 : 1 })}>
                  <Text style={{ color: colors.white, fontWeight: '800' }}>{exporting ? `正在导出 ${exportProgress?.current ?? 1}/8` : '选择文件夹并导出当前项目'}</Text>
                </Pressable>
              </View>

              <View style={{gap:10}}><WorkspaceButton label="完整 ZIP · 含原件与全部记录" disabled={exporting} onPress={()=>void exportRich()}/><WorkspaceButton label="导出到桌面 · 通用白板 ZIP" secondary disabled={exporting} onPress={()=>Alert.alert('导出桌面通用白板','包含结构、文档、原件、对话和知识引用。Android专属复习及掌握记录请用完整ZIP归档。',[{text:'取消',style:'cancel'},{text:'导出通用白板',onPress:()=>void exportRich(true)}])}/></View>
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

const focusPresets: { id: FocusPreset; label: string; color: string }[] = [
  { id: 'coral', label: '珊瑚', color: colors.coral },
  { id: 'blue', label: '蓝色', color: colors.blue },
  { id: 'green', label: '绿色', color: colors.green },
  { id: 'amber', label: '琥珀', color: colors.amber },
];
