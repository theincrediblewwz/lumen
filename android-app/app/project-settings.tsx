import { useEffect, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  DETAIL_LEVEL_LABELS,
  EXPLANATION_STYLE_LABELS,
  PROJECT_MODE_LABELS,
  createProjectContentPolicy,
} from '@/ai/content-policy';
import { prepareInitialExpansion } from '@/ai/initial-expansion-intent';
import {
  addTextSource,
  addWebSource,
  captureAndAddImageSource,
  fetchWebSourcePreview,
  pickAndAddDocumentSource,
  pickAndAddImageSources,
  type WebSourcePreview,
} from '@/ai/source-ingestion';
import {
  createProject,
  deleteProject,
  getGraph,
  updateProjectContentPolicy,
} from '@/data/knowledge-repository';
import {
  copyProjectSourceItems,
  deleteProjectSourceItem,
  listProjectSourceItems,
} from '@/data/source-items';
import { colors, radii } from '@/theme/tokens';
import type {
  DetailLevel,
  ExplanationStyle,
  KnowledgeGraph,
  ProjectMode,
  SourceItem,
} from '@/types/domain';

export default function ProjectSettingsScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const db = useSQLiteContext();
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [mode, setMode] = useState<ProjectMode>('learning');
  const [explanationStyle, setExplanationStyle] = useState<ExplanationStyle>('plain_language');
  const [detailLevel, setDetailLevel] = useState<DetailLevel>('detailed');
  const [allowOutsideKnowledge, setAllowOutsideKnowledge] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [sourceBusy, setSourceBusy] = useState<string | null>(null);
  const [textSourceVisible, setTextSourceVisible] = useState(false);
  const [textSourceTitle, setTextSourceTitle] = useState('');
  const [textSourceBody, setTextSourceBody] = useState('');
  const [webSourceVisible, setWebSourceVisible] = useState(false);
  const [webUrl, setWebUrl] = useState('');
  const [webPreview, setWebPreview] = useState<WebSourcePreview | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    Promise.all([getGraph(db, projectId), listProjectSourceItems(db, projectId)])
      .then(([value, sourceItems]) => {
        if (!active || !value) return;
        setGraph(value);
        setSources(sourceItems);
        setMode(value.project.contentPolicy.mode);
        setExplanationStyle(value.project.contentPolicy.explanationStyle);
        setDetailLevel(value.project.contentPolicy.detailLevel);
        setAllowOutsideKnowledge(value.project.contentPolicy.allowOutsideKnowledge);
      })
      .catch((error) => Alert.alert('无法读取项目设置', error instanceof Error ? error.message : '请稍后重试'));
    return () => { active = false; };
  }, [db, projectId]);

  const modeChanged = Boolean(graph && mode !== graph.project.contentPolicy.mode);
  const requiresCopy = Boolean(modeChanged && graph && graph.nodes.length > 1);
  const buttonLabel = useMemo(() => {
    if (saving) return '正在保存…';
    if (requiresCopy) return `创建${PROJECT_MODE_LABELS[mode]}副本并重新分析`;
    return '保存内容设置';
  }, [mode, requiresCopy, saving]);

  const chooseMode = (value: ProjectMode) => {
    setMode(value);
    if (value === 'summary') setAllowOutsideKnowledge(false);
  };

  const save = async () => {
    if (!graph || saving) return;
    setSaving(true);
    const policy = createProjectContentPolicy({
      mode,
      explanationStyle,
      detailLevel,
      allowOutsideKnowledge,
    });
    try {
      if (requiresCopy) {
        const suffix = mode === 'summary' ? '总结副本' : '学习副本';
        let created: Awaited<ReturnType<typeof createProject>> | null = null;
        try {
          created = await createProject(
            db,
            `${graph.project.title}（${suffix}）`,
            graph.project.sourceText,
            graph.project.topicId,
            policy,
          );
          await copyProjectSourceItems(db, graph.project.id, created.projectId);
          await prepareInitialExpansion(created.projectId);
          router.replace({
            pathname: '/project/[id]',
            params: { id: created.projectId, initialNodeId: created.rootNodeId },
          });
        } catch (error) {
          if (created) await deleteProject(db, created.projectId).catch(() => undefined);
          throw error;
        }
        return;
      }
      await updateProjectContentPolicy(db, graph.project.id, policy);
      router.back();
    } catch (error) {
      Alert.alert('内容设置没有保存', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  const refreshSources = async () => {
    if (!projectId) return;
    setSources(await listProjectSourceItems(db, projectId));
  };

  const runSourceTask = async (label: string, task: () => Promise<unknown>) => {
    if (sourceBusy) return;
    setSourceBusy(label);
    try {
      await task();
      await refreshSources();
    } catch (error) {
      Alert.alert('资料没有加入', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setSourceBusy(null);
    }
  };

  const saveTextSource = () => {
    void runSourceTask('正在保存文字', async () => {
      await addTextSource(db, graph!.project.id, textSourceTitle, textSourceBody);
      setTextSourceVisible(false);
      setTextSourceTitle('');
      setTextSourceBody('');
    });
  };

  const previewWebSource = () => {
    void runSourceTask('正在读取公开网页', async () => {
      setWebPreview(await fetchWebSourcePreview(webUrl));
    });
  };

  const saveWebSource = () => {
    if (!webPreview) return;
    void runSourceTask('正在保存网页', async () => {
      await addWebSource(db, graph!.project.id, webPreview);
      setWebSourceVisible(false);
      setWebUrl('');
      setWebPreview(null);
    });
  };

  const confirmDeleteSource = (source: SourceItem) => {
    Alert.alert(
      '删除这份资料？',
      '会移除它的提取文本与来源记录；已生成的节点和回答不会自动删除。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除资料',
          style: 'destructive',
          onPress: () => {
            void runSourceTask('正在删除资料', async () => {
              await deleteProjectSourceItem(db, source.id);
            });
          },
        },
      ],
    );
  };

  if (!graph) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.ink} />
      </View>
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, paddingBottom: 48, gap: 22 }}
    >
      <View style={{ gap: 6 }}>
        <Text style={{ color: colors.ink, fontSize: 24, fontWeight: '800' }}>内容与讲解</Text>
        <Text style={{ color: colors.inkMuted, fontSize: 14, lineHeight: 21 }}>
          这些设置会进入发送预览、快速生成和三阶段深入构建。它们控制 AI 怎么讲，不会偷偷改写已有文档。
        </Text>
      </View>

      <Section title="图谱模式">
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {(['learning', 'summary'] as const).map((value) => (
            <OptionCard
              key={value}
              selected={mode === value}
              title={PROJECT_MODE_LABELS[value]}
              description={value === 'learning'
                ? '从目标反向寻找前置、直觉与验证点'
                : '忠实提炼资料的层级、主张、证据与例子'}
              onPress={() => chooseMode(value)}
            />
          ))}
        </View>
        {requiresCopy ? (
          <Text style={{ color: colors.amber, fontSize: 12.5, lineHeight: 19 }}>
            当前图已有 {graph.nodes.length} 个节点。为避免把旧关系原地改义，切换模式会保留原图，并新建一个干净副本重新分析。
          </Text>
        ) : null}
      </Section>

      <Section title="表达方式">
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {(['plain_language', 'legacy'] as const).map((value) => (
            <OptionCard
              key={value}
              selected={explanationStyle === value}
              title={EXPLANATION_STYLE_LABELS[value]}
              description={value === 'plain_language'
                ? '先讲直觉和全局，再解释术语'
                : '准确、克制的标准教学表达'}
              onPress={() => setExplanationStyle(value)}
            />
          ))}
        </View>
      </Section>

      <Section title="内容长度">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {(['one_sentence', 'concise', 'detailed', 'deep'] as const).map((value) => (
            <Pill
              key={value}
              selected={detailLevel === value}
              label={DETAIL_LEVEL_LABELS[value]}
              onPress={() => setDetailLevel(value)}
            />
          ))}
        </View>
        <Text style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19 }}>
          一句话约 100 字以内；简短约 300–600 字；详细约 800–1600 字；深入可超过 1800 字并展开推导、边界与反例。
        </Text>
      </Section>

      <View style={{
        padding: 16,
        borderRadius: radii.medium,
        borderCurve: 'continuous',
        backgroundColor: colors.surfaceStrong,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
      }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '800' }}>允许资料外补充</Text>
          <Text style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 18 }}>
            {mode === 'summary'
              ? '开启后仍需把资料之外的内容明确标成“补充背景”。'
              : '学习模式可使用通用知识，但不确定内容必须标明。'}
          </Text>
        </View>
        <Switch
          value={allowOutsideKnowledge}
          onValueChange={setAllowOutsideKnowledge}
          trackColor={{ false: colors.line, true: colors.blueSoft }}
          thumbColor={allowOutsideKnowledge ? colors.blue : colors.gray}
        />
      </View>

      <Section title="资料来源">
        <Text style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19 }}>
          每次加入都会保存成独立版本，并记录页码、段落、图片或 URL 定位。AI 只会按本次问题从这些资料中选择有用片段。
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <SourceAction label="PDF / Markdown" onPress={() => {
            void runSourceTask('正在提取文件', () => pickAndAddDocumentSource(db, graph.project.id));
          }} />
          <SourceAction label="图片 OCR" onPress={() => {
            void runSourceTask('正在识别图片', () => pickAndAddImageSources(db, graph.project.id));
          }} />
          <SourceAction label="拍照 OCR" onPress={() => {
            void runSourceTask('正在识别照片', () => captureAndAddImageSource(db, graph.project.id));
          }} />
          <SourceAction label="粘贴文字" onPress={() => setTextSourceVisible(true)} />
          <SourceAction label="公开网页" onPress={() => setWebSourceVisible(true)} />
        </View>
        {sourceBusy ? (
          <View style={{ minHeight: 44, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <ActivityIndicator color={colors.blue} />
            <Text style={{ color: colors.ink, fontSize: 13, fontWeight: '700' }}>{sourceBusy}</Text>
          </View>
        ) : null}
        {sources.map((source) => (
          <View
            key={source.id}
            style={{
              padding: 15,
              borderRadius: radii.medium,
              borderCurve: 'continuous',
              backgroundColor: colors.surfaceStrong,
              gap: 5,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => router.push({
                    pathname: '/document/[id]',
                    params: { id: source.derivedDocumentId },
                  })}
                  style={({ pressed }) => ({ gap: 4, opacity: pressed ? 0.62 : 1 })}
                >
                  <Text numberOfLines={2} style={{ color: colors.ink, fontSize: 14.5, fontWeight: '800' }}>{source.title}</Text>
                  <Text style={{ color: colors.blue, fontSize: 11.5, fontWeight: '700' }}>查看提取内容与定位</Text>
                </Pressable>
                <Text style={{ color: colors.inkMuted, fontSize: 12 }}>
                  {sourceKindLabel(source.kind)} · {source.extractionStatus === 'failed'
                    ? '提取失败'
                    : `${source.segmentCount} 个片段 · ${source.extractedCharacters.toLocaleString()} 字符`}
                </Text>
                {source.extractionError ? (
                  <Text selectable style={{ color: colors.coral, fontSize: 11.5, lineHeight: 17 }}>{source.extractionError}</Text>
                ) : null}
                {source.sourceUrl ? (
                  <Text numberOfLines={1} style={{ color: colors.blue, fontSize: 11.5 }}>{source.sourceUrl}</Text>
                ) : null}
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={() => confirmDeleteSource(source)}
                hitSlop={10}
                style={({ pressed }) => ({ padding: 5, opacity: pressed ? 0.5 : 1 })}
              >
                <Text style={{ color: colors.coral, fontSize: 12.5, fontWeight: '700' }}>删除</Text>
              </Pressable>
            </View>
          </View>
        ))}
        {!sources.length ? (
          <View style={{ padding: 16, borderRadius: radii.medium, borderCurve: 'continuous', backgroundColor: colors.surfaceStrong }}>
            <Text style={{ color: colors.inkMuted, fontSize: 13, lineHeight: 20 }}>
              还没有版本化资料。新建时粘贴的原始内容仍会保留；从这里加入的新资料会带独立来源记录。
            </Text>
          </View>
        ) : null}
      </Section>

      <Pressable
        accessibilityRole="button"
        disabled={saving}
        onPress={save}
        style={({ pressed }) => ({
          minHeight: 56,
          paddingHorizontal: 20,
          borderRadius: 28,
          borderCurve: 'continuous',
          backgroundColor: colors.ink,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: 9,
          opacity: saving ? 0.45 : pressed ? 0.8 : 1,
        })}
      >
        {saving ? <ActivityIndicator color={colors.white} /> : null}
        <Text style={{ color: colors.white, fontSize: 15, fontWeight: '800' }}>{buttonLabel}</Text>
      </Pressable>

      <SourceTextModal
        visible={textSourceVisible}
        title={textSourceTitle}
        body={textSourceBody}
        busy={Boolean(sourceBusy)}
        onTitleChange={setTextSourceTitle}
        onBodyChange={setTextSourceBody}
        onCancel={() => setTextSourceVisible(false)}
        onSave={saveTextSource}
      />

      <WebSourceModal
        visible={webSourceVisible}
        url={webUrl}
        preview={webPreview}
        busy={Boolean(sourceBusy)}
        onUrlChange={(value) => {
          setWebUrl(value);
          setWebPreview(null);
        }}
        onCancel={() => {
          setWebSourceVisible(false);
          setWebPreview(null);
        }}
        onPreview={previewWebSource}
        onSave={saveWebSource}
      />
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: colors.ink, fontSize: 13, fontWeight: '800' }}>{title}</Text>
      {children}
    </View>
  );
}

function OptionCard({
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
        minHeight: 94,
        padding: 14,
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
      <Text style={{ color: colors.inkMuted, fontSize: 12, lineHeight: 18 }}>{description}</Text>
    </Pressable>
  );
}

function Pill({
  selected,
  label,
  onPress,
}: {
  selected: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 40,
        paddingHorizontal: 15,
        borderRadius: 20,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: selected ? colors.ink : colors.surfaceStrong,
        opacity: pressed ? 0.72 : 1,
      })}
    >
      <Text style={{ color: selected ? colors.white : colors.ink, fontSize: 13, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}

function SourceAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 40,
        paddingHorizontal: 14,
        borderRadius: 20,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.blueSoft,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color: colors.blue, fontSize: 12.5, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  );
}

function SourceTextModal({
  visible,
  title,
  body,
  busy,
  onTitleChange,
  onBodyChange,
  onCancel,
  onSave,
}: {
  visible: boolean;
  title: string;
  body: string;
  busy: boolean;
  onTitleChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(32,32,31,0.28)' }}>
        <View style={{ margin: 12, padding: 18, borderRadius: 30, borderCurve: 'continuous', backgroundColor: colors.surfaceStrong, gap: 14 }}>
          <Text style={{ color: colors.ink, fontSize: 20, fontWeight: '800' }}>加入文字资料</Text>
          <TextInput
            value={title}
            onChangeText={onTitleChange}
            placeholder="资料标题（可选）"
            placeholderTextColor={colors.gray}
            style={{ minHeight: 48, paddingHorizontal: 14, borderRadius: radii.medium, borderCurve: 'continuous', backgroundColor: colors.graySoft, color: colors.ink }}
          />
          <TextInput
            value={body}
            onChangeText={onBodyChange}
            placeholder="粘贴资料正文…"
            placeholderTextColor={colors.gray}
            multiline
            textAlignVertical="top"
            style={{ minHeight: 220, padding: 14, borderRadius: radii.medium, borderCurve: 'continuous', backgroundColor: colors.graySoft, color: colors.ink, fontSize: 14, lineHeight: 21 }}
          />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <ModalButton label="取消" onPress={onCancel} secondary />
            <ModalButton label={busy ? '保存中…' : '保存为新版本'} onPress={onSave} disabled={busy || !body.trim()} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function WebSourceModal({
  visible,
  url,
  preview,
  busy,
  onUrlChange,
  onCancel,
  onPreview,
  onSave,
}: {
  visible: boolean;
  url: string;
  preview: WebSourcePreview | null;
  busy: boolean;
  onUrlChange: (value: string) => void;
  onCancel: () => void;
  onPreview: () => void;
  onSave: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(32,32,31,0.28)' }}>
        <View style={{ margin: 12, padding: 18, borderRadius: 30, borderCurve: 'continuous', backgroundColor: colors.surfaceStrong, gap: 14 }}>
          <Text style={{ color: colors.ink, fontSize: 20, fontWeight: '800' }}>加入公开网页</Text>
          <Text style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19 }}>
            只读取无需登录的 HTTP/HTTPS 正文。私有飞书文档请先导出 PDF 或 Markdown；保存前一定先预览。
          </Text>
          <TextInput
            value={url}
            onChangeText={onUrlChange}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://example.com/article"
            placeholderTextColor={colors.gray}
            style={{ minHeight: 52, paddingHorizontal: 14, borderRadius: radii.medium, borderCurve: 'continuous', backgroundColor: colors.graySoft, color: colors.ink }}
          />
          {preview ? (
            <View style={{ maxHeight: 240, padding: 14, borderRadius: radii.medium, borderCurve: 'continuous', backgroundColor: colors.canvas, gap: 6 }}>
              <Text numberOfLines={2} style={{ color: colors.ink, fontSize: 14, fontWeight: '800' }}>{preview.title}</Text>
              <Text selectable numberOfLines={2} style={{ color: colors.blue, fontSize: 11.5 }}>{preview.finalUrl}</Text>
              <Text style={{ color: colors.inkMuted, fontSize: 11.5 }}>
                {preview.mediaType} · {preview.byteSize.toLocaleString()} 字节{preview.truncated ? ' · 正文已截断到 50 万字符' : ''}
              </Text>
              <ScrollView nestedScrollEnabled>
                <Text selectable style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19 }}>{preview.text.slice(0, 2_000)}</Text>
              </ScrollView>
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <ModalButton label="取消" onPress={onCancel} secondary />
            <ModalButton
              label={preview ? '确认保存' : busy ? '读取中…' : '读取并预览'}
              onPress={preview ? onSave : onPreview}
              disabled={busy || !url.trim()}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ModalButton({
  label,
  onPress,
  secondary = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 48,
        borderRadius: 24,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: secondary ? colors.graySoft : colors.ink,
        opacity: disabled ? 0.4 : pressed ? 0.75 : 1,
      })}
    >
      <Text style={{ color: secondary ? colors.ink : colors.white, fontSize: 13.5, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  );
}

function sourceKindLabel(kind: SourceItem['kind']) {
  return {
    text: '文字',
    markdown: 'Markdown',
    pdf: 'PDF',
    image: '图片 OCR',
    web: '网页',
  }[kind];
}
