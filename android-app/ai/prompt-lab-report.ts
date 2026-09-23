import type { PromptLabRun } from '@/ai/prompt-lab-runner';
import { repairMarkdownMathJsonEscapes } from '@/ai/markdown-math-safety';

type ReadablePromptLabOutput = {
  answerMarkdown: string;
  keyPoints: Array<{
    title: string;
    subtitle: string | null;
    importance: number | null;
    importanceReason: string | null;
    relationToFocus: string | null;
    documentMarkdown: string | null;
  }>;
};

export function formatPromptLabRunMarkdown(run: PromptLabRun) {
  const lines = [
    '# LearnStuff MiMo v3 教学回归',
    '',
    '> 这是供人阅读的报告：先显示正常回答，再显示建议进入图谱的知识点。完整原始响应、结构诊断和计费字段仍保存在同名 JSON 审计文件中。',
    '',
    `- 运行：${run.runId}`,
    `- 状态：${run.status}`,
    `- 进度：${run.completedCalls}/${run.gate.calls}`,
    `- 模型：${run.provider.model}`,
    `- thinking：${run.provider.thinking}`,
    `- 自动重试：${run.provider.retries}`,
    `- 输入 tokens：${run.totalInputTokens}`,
    `- 输出 tokens：${run.totalOutputTokens}`,
    `- 估算费用：¥${run.totalEstimatedCostCny.toFixed(6)}`,
  ];
  for (const result of run.results) {
    const readable = result.content ? parseReadablePromptLabOutput(result.content) : null;
    lines.push(
      '',
      `## ${result.index}. ${result.caseTitle} · ${result.blindLabel}`,
      '',
      `- 状态：${result.status}`,
    );
    if (result.error) {
      lines.push('', '### 未完成', '', `${result.error.code} · ${result.error.message}`);
      if (result.content) {
        lines.push('', '### 原始响应（仅用于诊断，不作为合格答案）', '', fenced(result.content, 'text'));
      }
    } else if (readable) {
      lines.push('', '### 回答', '', readable.answerMarkdown, '');
      lines.push('', '### 建议进入图谱的知识点', '');
      if (!readable.keyPoints.length) {
        lines.push('（这份响应没有生成可读取的知识点。）');
      }
      for (const [index, point] of readable.keyPoints.entries()) {
        const importance = point.importance === null ? '未给出' : `${point.importance}/10`;
        lines.push('', `#### ${index + 1}. ${safeHeading(point.title)} · ${importance}`, '');
        if (point.subtitle) lines.push(`*${point.subtitle}*`, '');
        if (point.relationToFocus) lines.push(`- 与当前知识点的关系：${point.relationToFocus}`);
        if (point.importanceReason) lines.push(`- 为什么重要：${point.importanceReason}`);
        if (point.documentMarkdown) lines.push('', point.documentMarkdown);
      }
    } else {
      lines.push(
        '',
        '### 无法生成可读报告',
        '',
        `结构诊断：${result.diagnostic?.warnings.length ? result.diagnostic.warnings.join('；') : '返回内容不是支持的回答结构'}`,
        '',
        '### 原始响应（仅用于诊断）',
        '',
        fenced(result.content ?? '', 'text'),
      );
    }
    lines.push(
      '',
      '### 运行记录',
      '',
      `- 上下文指纹：${result.contextFingerprint}`,
      `- tokens：${result.inputTokens ?? '未知'} → ${result.outputTokens ?? '未知'}`,
      `- 延迟：${result.latencyMs ?? '未知'} ms`,
      `- 估算费用：${result.estimatedCostCny === null ? '未知' : `¥${result.estimatedCostCny.toFixed(6)}`}`,
      `- 结构诊断：${diagnosticSummary(result.diagnostic)}`,
      result.error ? '- Codex 评分：不评分（未获得合格回答）' : '- Codex 评分：待填写',
    );
  }
  return `${lines.join('\n')}\n`;
}

function diagnosticSummary(diagnostic: PromptLabRun['results'][number]['diagnostic']) {
  if (!diagnostic) return '未获得响应，无法诊断';
  return diagnostic.warnings.length ? diagnostic.warnings.join('；') : '通过';
}

function parseReadablePromptLabOutput(content: string): ReadablePromptLabOutput | null {
  try {
    const value = JSON.parse(content) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const answerMarkdown = typeof record.answerMarkdown === 'string'
      ? repairMarkdownMathJsonEscapes(record.answerMarkdown.trim()).text
      : '';
    if (!answerMarkdown) return null;
    const rawPoints = Array.isArray(record.keyPoints) ? record.keyPoints : [];
    return {
      answerMarkdown,
      keyPoints: rawPoints.flatMap((point) => {
        if (!point || typeof point !== 'object' || Array.isArray(point)) return [];
        const item = point as Record<string, unknown>;
        const title = typeof item.title === 'string'
          ? repairMarkdownMathJsonEscapes(item.title.trim()).text
          : '';
        if (!title) return [];
        return [{
          title,
          subtitle: textOrNull(item.subtitle),
          importance: Number.isInteger(item.importance) ? Number(item.importance) : null,
          importanceReason: textOrNull(item.importanceReason),
          relationToFocus: textOrNull(item.relationToFocus),
          documentMarkdown: textOrNull(item.documentMarkdown),
        }];
      }),
    };
  } catch {
    return null;
  }
}

function textOrNull(value: unknown) {
  return typeof value === 'string' && value.trim()
    ? repairMarkdownMathJsonEscapes(value.trim()).text
    : null;
}

function safeHeading(value: string) {
  return value.replace(/[\r\n#]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function fenced(content: string, language: string) {
  const fence = content.includes('```') ? '````' : '```';
  return `${fence}${language}\n${content}\n${fence}`;
}
