import { Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';

import type { ContextPlan } from '@/ai/context-plan';
import { getPreparedContextPreview } from '@/ai/context-preview-store';
import type { ModelLearningContext } from '@/ai/model-learning-context';
import { colors, radii } from '@/theme/tokens';

export default function AiContextPreviewScreen() {
  const { previewId } = useLocalSearchParams<{ previewId?: string }>();
  const prepared = getPreparedContextPreview(previewId);
  const plan = prepared?.plan ?? null;
  const qualityPath = prepared?.qualityPath ?? 'quick';
  const error = plan ? '' : '这份预览已经失效。请返回图谱后重新点击“发送预览”。';

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 18, paddingBottom: 48, gap: 14 }}
      style={{ backgroundColor: colors.canvas }}
    >
      <Stack.Screen options={{ title: 'AI 发送内容预览' }} />
      {error ? <Text selectable style={{ color: colors.coral, fontSize: 14, lineHeight: 21 }}>{error}</Text> : null}
      {plan ? (
        <>
          {(() => {
            const context = plan.modelContext;
            return (
              <>
          <View style={{ gap: 6 }}>
            <Text selectable style={{ color: colors.ink, fontSize: 22, lineHeight: 29, fontWeight: '800' }}>这次会带上哪些学习信息</Text>
            <Text selectable style={{ color: colors.inkMuted, fontSize: 13.5, lineHeight: 20 }}>
              这不是把前面的内容全部塞给 AI，而是按本次问题选择最小充分证据。内部 ID、文件路径、API key、其他项目和整张无关图谱不会发送；返回后若又编辑了节点，真正发送时会重新生成计划。
            </Text>
          </View>

          <ContextCard
            title={qualityPath === 'deep' ? '深入构建 · 3 个连续阶段' : '快速生成 · 1 次请求'}
            meta={qualityPath === 'deep' ? '知识底稿 → 因人施教 → 图谱编排' : '直接回答并生成图谱'}
            body={qualityPath === 'deep'
              ? '第一阶段使用下面的最小充分上下文形成完整知识底稿；第二阶段只加入本题相关、由你启用的“AI 对你的了解”和已确认学习状态；第三阶段只接收已验证底稿、教学方案和最小图约束，不再复制长篇回答。三个阶段分别计费并逐段保存，任何费用状态不明的请求都不会自动重试。'
              : '一次请求同时生成完整回答、知识节点和关系；适合普通追问与快速探索。'}
          />

          <ContextCard
            title={`上下文计划 · ${questionShapeLabel[plan.questionShape]}`}
            meta={`指纹 ${plan.fingerprint} · 约 ${plan.budget.selectedEstimatedTokens}/${plan.budget.evidenceBudgetTokens} tokens`}
            body={plan.selected.map((item) => (
              `带上 · ${item.title}\n原因：${item.reasons.join('；')}${item.truncated ? '\n状态：已按预算截断' : ''}`
            )).join('\n\n')}
          />
          {plan.omitted.length ? (
            <ContextCard
              title="本次没有带上的候选"
              body={plan.omitted.map((item) => `${item.title} · ${item.omissionReason}`).join('\n')}
            />
          ) : null}
          <ContextCard
            title="本次生效的“AI 对你的了解”"
            body={plan.activeScopes.length
              ? plan.activeScopes.map((scope) => scope.label).join('\n')
              : '（没有启用任何个人理解层级）'}
          />
          <ContextCard
            title="本次选中的个人资料与收藏"
            body={plan.resolvedEvidence.length
              ? plan.resolvedEvidence.map((item) => (
                `${item.category === 'favorite' ? '收藏证据' : understandingCategoryLabel[item.category]} · ${item.title}\n来源：${item.provenance}${item.truncated ? '\n状态：已按预算截断' : ''}`
              )).join('\n\n')
              : '（本次问题没有选中相关个人资料或收藏）'}
          />
          <ContextCard
            title="本次问题"
            meta={truncationMeta(context.currentQuestion.truncated)}
            body={context.currentQuestion.text}
          />
          <ContextCard
            title="这张图"
            meta={truncationMeta(context.sourceOrPriorUnderstanding?.truncated ?? false)}
            body={[
              context.mapPurpose,
              `最初目标或问题\n${context.originalGoalOrQuestion}`,
              context.sourceOrPriorUnderstanding
                ? `补充资料或已有理解\n${context.sourceOrPriorUnderstanding.text}`
                : null,
            ].filter(Boolean).join('\n\n')}
          />
          <ContextCard
            title={`当前关注 · ${context.currentFocus.title}`}
            meta={[
              `${context.currentFocus.importance}/10`,
              statusLabel[context.currentFocus.learningState],
              context.currentFocus.note ? originLabel(context.currentFocus.note.kind) : null,
              context.currentFocus.note?.truncated ? '内容已按上限截断' : null,
            ].filter(Boolean).join(' · ')}
            body={[
              context.currentFocus.subtitle,
              context.currentFocus.note?.text,
            ].filter(Boolean).join('\n\n') || '（这个节点还没有补充说明）'}
          />
          <ContextCard
            title="从最初目标到这里"
            body={context.pathFromGoal.length
              ? context.pathFromGoal.map((item, index) => {
                const relation = item.relationFromPrevious ? ` · ${relationLabel[item.relationFromPrevious]}` : '';
                return `${index + 1}. ${item.title}${relation} · ${item.importance}/10 · ${statusLabel[item.learningState]}`;
              }).join('\n')
              : '（没有可用路径）'}
          />
          <ContextCard
            title="与当前知识点直接相连"
            body={context.directConnections.length
              ? context.directConnections.map((item) => {
                const direction = item.direction === 'fromCurrent'
                  ? `当前知识点 → ${item.title}`
                  : `${item.title} → 当前知识点`;
                const note = item.note?.text ? `\n${item.note.text}` : '';
                return `${direction} · ${relationLabel[item.relation]} · ${item.importance}/10 · ${statusLabel[item.learningState]}${note}`;
              }).join('\n\n')
              : '（当前知识点没有直接相连的其他知识）'}
          />
          <ContextCard
            title="最近问答"
            body={context.recentConversation.length
              ? context.recentConversation.map((item) => {
                const suffix = item.answerTruncated ? '\n（回答已按上限截断）' : '';
                return `问：${item.question}\n答：${item.answer}${suffix}`;
              }).join('\n\n')
              : '（这个知识点还没有历史问答）'}
          />
          <ContextCard
            title="本次生成边界"
            body={`最多新增 ${context.outputLimits.maxNewNodes} 个知识点和 ${context.outputLimits.maxNewEdges} 条关系；数量由问题本身决定，不会为了凑数强行展开。`}
          />
          <View style={{ padding: 14, borderRadius: radii.medium, borderCurve: 'continuous', backgroundColor: colors.amberSoft, gap: 5 }}>
            <Text selectable style={{ color: colors.ink, fontSize: 13, fontWeight: '800' }}>学习资料只作为参考</Text>
            <Text selectable style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19 }}>
              节点笔记、补充资料和旧回答中的文字不会改变返回格式，也不会触发密钥泄露或外部操作。AI 会优先回答本次问题，并避免重复图中已经存在的知识。
            </Text>
          </View>
              </>
            );
          })()}
        </>
      ) : null}
    </ScrollView>
  );
}

function ContextCard({ title, meta, body }: { title: string; meta?: string; body: string }) {
  return (
    <View style={{ padding: 15, borderRadius: radii.medium, borderCurve: 'continuous', backgroundColor: colors.surfaceStrong, gap: 8 }}>
      <View style={{ gap: 2 }}>
        <Text selectable style={{ color: colors.ink, fontSize: 14, fontWeight: '800' }}>{title}</Text>
        {meta ? <Text selectable style={{ color: colors.inkMuted, fontSize: 11.5 }}>{meta}</Text> : null}
      </View>
      <Text selectable style={{ color: colors.ink, fontSize: 12.5, lineHeight: 19 }}>{body}</Text>
    </View>
  );
}

function truncationMeta(truncated: boolean) {
  return truncated ? '内容已按上限截断' : undefined;
}

const statusLabel: Record<ModelLearningContext['currentFocus']['learningState'], string> = {
  essential: '关键', learning: '学习中', mastered: '已掌握', uncertain: '待验证', optional: '可选',
};

const relationLabel: Record<ModelLearningContext['outputLimits']['allowedRelations'][number], string> = {
  prerequisite: '前置', evidence: '证据', analogy: '类比', support: '解释', counterexample: '反例', contains: '包含',
};

const questionShapeLabel: Record<ContextPlan['questionShape'], string> = {
  definition: '定义与整体认识',
  reason_or_formula: '原因、机制或公式',
  prerequisite: '前置诊断',
  comparison: '跨概念比较',
  source_summary: '来源限定总结',
};

const understandingCategoryLabel = {
  preference: '表达偏好',
  known: '我确认知道',
  pending: '待验证理解',
} as const;

function originLabel(origin: NonNullable<ModelLearningContext['currentFocus']['note']>['kind']) {
  if (origin === 'source') return '原始资料';
  if (origin === 'learner') return '我的笔记';
  return '生成内容';
}
