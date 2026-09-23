import { Stack, useFocusEffect, router } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getByokCredentials, getByokProfileStatus } from '@/ai/byok-profile';
import {
  estimatePromptLabGate,
  PROMPT_LAB_BASE_URL,
  PROMPT_LAB_MODEL,
  PROMPT_LAB_PRICE,
} from '@/ai/prompt-lab';
import {
  exportPromptLabRun,
  getLatestPromptLabRun,
  runPromptLab,
  type PromptLabResult,
  type PromptLabRun,
} from '@/ai/prompt-lab-runner';
import { AppIcon } from '@/components/app-icon';
import { colors, floatingShadow, radii } from '@/theme/tokens';

export default function PromptLabScreen() {
  const insets = useSafeAreaInsets();
  const controllerRef = useRef<AbortController | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<PromptLabRun | null>(null);
  const [expandedResult, setExpandedResult] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [exporting, setExporting] = useState(false);
  const gate = useMemo(() => estimatePromptLabGate('prompt-lab-gate-v1'), []);

  const refresh = useCallback(async () => {
    const [status, latest] = await Promise.all([getByokProfileStatus(), getLatestPromptLabRun()]);
    const profile = status.profile;
    setReady(Boolean(
      status.hasApiKey
      && profile?.kind === 'mimo'
      && profile.baseUrl === PROMPT_LAB_BASE_URL
      && profile.model === PROMPT_LAB_MODEL
      && profile.jsonMode
      && profile.tokenLimitField === 'max_completion_tokens',
    ));
    setRun(latest);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => {
    let active = true;
    refresh().catch(() => {
      if (active) {
        setMessage('无法读取 MiMo 配置或上次实验');
        setLoading(false);
      }
    });
    return () => { active = false; };
  }, [refresh]));

  const confirmStart = () => {
    if (!ready || running) return;
    Alert.alert(
      '开始 3 次真实 MiMo v3 回归？',
      [
        `固定回归：公式、前置诊断、来源限定总结，共 ${gate.calls} 次。`,
        `输入约 ${gate.estimatedInputTokens.toLocaleString()} tokens；按 UTF-8 字节数取保守输入上界 ${gate.maximumInputTokens.toLocaleString()} tokens；输出硬上限 ${gate.maximumOutputTokens.toLocaleString()} tokens。`,
        `按 2026-07-15 国内缓存未命中输入 ¥1/M、输出 ¥2/M 计算，本地授权警戒线 ¥${gate.maximumEstimatedCostCny.toFixed(4)}。`,
        'thinking 已关闭，不使用工具或联网搜索；任何失败、超时或结果不明都会立即停止且不自动重试。',
      ].join('\n\n'),
      [
        { text: '取消', style: 'cancel' },
        { text: '确认付费并开始', onPress: () => void startRun() },
      ],
    );
  };

  const startRun = async () => {
    if (running) return;
    setRunning(true);
    setMessage('');
    setExpandedResult(null);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const credentials = await getByokCredentials();
      if (!credentials) throw new Error('尚未在 AI 设置中安全保存 MiMo key');
      const finished = await runPromptLab(credentials, {
        signal: controller.signal,
        onProgress: setRun,
      });
      setRun(finished);
      if (finished.status === 'completed') setMessage('3 次 v3 回归已完成，可以导出正常阅读版 Markdown。');
      else if (finished.status === 'stopped') setMessage('实验已停止；不会自动补发未完成请求。');
      else setMessage(finished.results.at(-1)?.error?.message ?? '实验已停止');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '实验无法开始');
    } finally {
      controllerRef.current = null;
      setRunning(false);
    }
  };

  const exportRun = async () => {
    if (!run || exporting) return;
    setExporting(true);
    setMessage('');
    try {
      const exported = await exportPromptLabRun(run);
      setMessage(exported ? '机器审计 JSON 与正常阅读版 Markdown 已导出到所选文件夹' : '已取消导出');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '导出失败');
    } finally {
      setExporting(false);
    }
  };

  const stop = () => {
    controllerRef.current?.abort();
    setMessage('正在停止；当前请求的计费结果可能不确定，停止后不会重试。');
  };

  if (loading) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas }}><ActivityIndicator color={colors.ink} /></View>;
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.canvas }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 18, paddingBottom: 32 + insets.bottom, gap: 14 }}
    >
      <Stack.Screen options={{ title: 'Prompt v3 回归' }} />

      <View style={{ gap: 6 }}>
        <Text selectable style={{ color: colors.ink, fontSize: 23, lineHeight: 30, fontWeight: '800' }}>验证新的教学 Prompt</Text>
        <Text selectable style={{ color: colors.inkMuted, fontSize: 13.5, lineHeight: 21 }}>
          v3 用证据边界保证不跑题，再用全景、人话和最小例子组织讲解。本轮只检查最容易出错的公式、前置层级和来源限定。
        </Text>
      </View>

      <View style={{ padding: 16, borderRadius: radii.large, borderCurve: 'continuous', backgroundColor: ready ? colors.greenSoft : colors.amberSoft, gap: 7 }}>
        <Text selectable style={{ color: colors.ink, fontSize: 14, fontWeight: '800' }}>
          {ready ? 'MiMo 实验配置已就绪' : '还不能开始真实实验'}
        </Text>
        <Text selectable style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19 }}>
          必须安全保存官方 MiMo 预设：{PROMPT_LAB_BASE_URL} · {PROMPT_LAB_MODEL} · JSON mode · max_completion_tokens。
        </Text>
        {!ready ? (
          <Pressable onPress={() => router.push('/ai-settings')} style={({ pressed }) => ({
            alignSelf: 'flex-start',
            paddingHorizontal: 14,
            minHeight: 40,
            borderRadius: 20,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.surfaceStrong,
            opacity: pressed ? 0.7 : 1,
          })}>
            <Text style={{ color: colors.ink, fontSize: 12.5, fontWeight: '800' }}>打开 AI 设置</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={cardStyle}>
        <Text selectable style={{ color: colors.ink, fontSize: 15, fontWeight: '800' }}>本轮授权范围</Text>
        <Metric label="请求" value={`${gate.calls} 次`} />
        <Metric label="输入估算" value={`${gate.estimatedInputTokens.toLocaleString()} tokens`} />
        <Metric label="保守输入上界" value={`${gate.maximumInputTokens.toLocaleString()} tokens`} />
        <Metric label="输出硬上限" value={`${gate.maximumOutputTokens.toLocaleString()} tokens`} />
        <Metric label="本地授权警戒线" value={`¥${gate.maximumEstimatedCostCny.toFixed(4)}`} />
        <Text selectable style={{ color: colors.inkMuted, fontSize: 11.5, lineHeight: 18 }}>
          价格快照：{PROMPT_LAB_PRICE.effectiveDate}，按缓存未命中输入计算；保守输入上界取序列化文本的 UTF-8 字节数。实际 token 与费用仍以服务商账单为准。
        </Text>
      </View>

      {run ? (
        <View style={cardStyle}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {running ? <ActivityIndicator color={colors.blue} /> : <AppIcon name="science" color={colors.blue} size={22} />}
            <View style={{ flex: 1, gap: 2 }}>
              <Text selectable style={{ color: colors.ink, fontSize: 15, fontWeight: '800' }}>{runStatusLabel(run.status)}</Text>
              <Text selectable style={{ color: colors.inkMuted, fontSize: 12, fontVariant: ['tabular-nums'] }}>
                {run.completedCalls}/{run.gate.calls} · {run.totalInputTokens + run.totalOutputTokens} tokens · ¥{run.totalEstimatedCostCny.toFixed(6)}
              </Text>
            </View>
          </View>
          <View style={{ height: 7, borderRadius: 4, backgroundColor: colors.line, overflow: 'hidden' }}>
            <View style={{ width: `${run.completedCalls / run.gate.calls * 100}%`, height: '100%', backgroundColor: colors.blue }} />
          </View>
          <Text selectable style={{ color: colors.inkMuted, fontSize: 11.5, lineHeight: 18 }}>
            机器 JSON 与正常阅读版 Markdown 逐次保存在 App 私有目录；其中不含 API key。
          </Text>
        </View>
      ) : null}

      {message ? (
        <Text selectable accessibilityLiveRegion="polite" style={{ color: message.includes('完成') ? colors.green : colors.coral, fontSize: 12.5, lineHeight: 19 }}>
          {message}
        </Text>
      ) : null}

      {running ? (
        <ActionButton label="停止实验" icon="stop-circle" destructive onPress={stop} />
      ) : (
        <ActionButton label="查看费用并开始真实实验" icon="play-arrow" primary disabled={!ready} onPress={confirmStart} />
      )}

      {run?.results.length ? (
        <View style={{ gap: 10 }}>
          <Text selectable style={{ color: colors.ink, fontSize: 16, fontWeight: '800' }}>v3 回归结果</Text>
          {!running ? (
            <ActionButton
              label={exporting ? '正在导出…' : '导出结果副本'}
              icon="folder"
              disabled={exporting}
              onPress={exportRun}
            />
          ) : null}
          {run.results.map((result) => (
            <ResultCard
              key={`${result.index}-${result.blindLabel}`}
              result={result}
              expanded={expandedResult === result.index}
              onPress={() => setExpandedResult((current) => current === result.index ? null : result.index)}
            />
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

function ResultCard({ result, expanded, onPress }: { result: PromptLabResult; expanded: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({
      ...cardStyle,
      opacity: pressed ? 0.76 : 1,
    })}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: result.status === 'succeeded' ? colors.blueSoft : colors.amberSoft, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: result.status === 'succeeded' ? colors.blue : colors.coral, fontSize: 12, fontWeight: '900' }}>{result.index}</Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text selectable style={{ color: colors.ink, fontSize: 13.5, fontWeight: '800' }}>{result.caseTitle}</Text>
          <Text selectable style={{ color: colors.inkMuted, fontSize: 11.5 }}>
            {result.blindLabel} · {result.inputTokens ?? '?'} → {result.outputTokens ?? '?'} tokens · {result.latencyMs ?? '?'} ms
          </Text>
        </View>
        <AppIcon name={expanded ? 'expand-less' : 'expand-more'} color={colors.inkMuted} size={21} />
      </View>
      {result.error ? <Text selectable style={{ color: colors.coral, fontSize: 12, lineHeight: 18 }}>{result.error.message}</Text> : null}
      {expanded && result.content ? (
        <View style={{ gap: 7 }}>
          <Text selectable style={{ color: result.diagnostic?.warnings.length ? colors.coral : colors.green, fontSize: 11.5, fontWeight: '800' }}>
            {result.diagnostic?.warnings.length ? result.diagnostic.warnings.join('；') : '结构检查通过'}
          </Text>
          <Text selectable style={{ color: colors.ink, fontSize: 12, lineHeight: 19 }}>{formatResultContent(result.content)}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function formatResultContent(content: string) {
  try {
    const parsed = JSON.parse(content) as { answerMarkdown?: unknown; keyPoints?: unknown[] };
    const answer = typeof parsed.answerMarkdown === 'string' ? parsed.answerMarkdown : content;
    const points = Array.isArray(parsed.keyPoints)
      ? parsed.keyPoints.map((item) => {
        if (!item || typeof item !== 'object') return null;
        const point = item as { title?: unknown; importance?: unknown; importanceReason?: unknown };
        return `• ${String(point.title ?? '未命名')} · ${String(point.importance ?? '?')}/10\n  ${String(point.importanceReason ?? '')}`;
      }).filter(Boolean).join('\n\n')
      : '';
    return points ? `${answer}\n\n图谱要点\n${points}` : answer;
  } catch {
    return content;
  }
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Text selectable style={{ flex: 1, color: colors.inkMuted, fontSize: 12.5 }}>{label}</Text>
      <Text selectable style={{ color: colors.ink, fontSize: 12.5, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{value}</Text>
    </View>
  );
}

function ActionButton({ label, icon, onPress, primary, destructive, disabled }: {
  label: string;
  icon: Parameters<typeof AppIcon>[0]['name'];
  onPress: () => void;
  primary?: boolean;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => ({
      minHeight: 54,
      borderRadius: 27,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: 8,
      backgroundColor: destructive ? colors.amberSoft : primary ? colors.ink : colors.surfaceStrong,
      opacity: disabled ? 0.35 : pressed ? 0.72 : 1,
      boxShadow: floatingShadow,
    })}>
      <AppIcon name={icon} color={destructive ? colors.coral : primary ? colors.surfaceStrong : colors.ink} size={20} />
      <Text style={{ color: destructive ? colors.coral : primary ? colors.surfaceStrong : colors.ink, fontSize: 13.5, fontWeight: '900' }}>{label}</Text>
    </Pressable>
  );
}

function runStatusLabel(status: PromptLabRun['status']) {
  if (status === 'running') return '模型正在依次回答';
  if (status === 'completed') return 'v3 回归已完成';
  if (status === 'stopped') return '实验已停止';
  return '实验因错误停止';
}

const cardStyle = {
  padding: 16,
  borderRadius: radii.large,
  borderCurve: 'continuous' as const,
  backgroundColor: colors.surfaceStrong,
  boxShadow: floatingShadow,
  gap: 10,
};
