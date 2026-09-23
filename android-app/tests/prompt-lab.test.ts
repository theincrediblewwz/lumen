import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBlindPromptOrder,
  createPromptLabV3Requests,
  diagnosePromptLabOutput,
  estimateMimoCostCny,
  estimatePromptLabGate,
  preparePromptLabRequest,
  PROMPT_LAB_CASES,
  PROMPT_LAB_MAX_CALLS,
  PROMPT_LAB_V3_CASE_IDS,
} from '../ai/prompt-lab';
import { formatPromptLabRunMarkdown } from '../ai/prompt-lab-report';
import type { PromptLabRun } from '../ai/prompt-lab-runner';

test('freezes five cases by three anonymous variants without changing model parameters or context', () => {
  const order = createBlindPromptOrder('run-20260728');
  assert.equal(PROMPT_LAB_CASES.length, 5);
  assert.equal(order.length, 3);
  assert.equal(PROMPT_LAB_CASES.length * order.length, 15);
  assert.deepEqual(new Set(order.map((item) => item.label)).size, 3);
  assert.deepEqual(new Set(order.map((item) => item.variantId)).size, 3);

  const prepared = order.map((variant) => preparePromptLabRequest(PROMPT_LAB_CASES[0], variant));
  assert.ok(prepared.every((item) => item.userPrompt === prepared[0].userPrompt));
  assert.ok(prepared.every((item) => JSON.stringify(item.parameters) === JSON.stringify(prepared[0].parameters)));
  assert.ok(prepared.every((item) => item.contextPlan.fingerprint === prepared[0].contextPlan.fingerprint));
  assert.equal(new Set(prepared.map((item) => item.systemPrompt)).size, 3);
});

test('freezes the three-case evidence-reader v3 regression without changing provider controls', () => {
  const prepared = createPromptLabV3Requests();
  assert.equal(prepared.length, PROMPT_LAB_MAX_CALLS);
  assert.deepEqual(prepared.map((item) => item.caseId), [...PROMPT_LAB_V3_CASE_IDS]);
  assert.ok(prepared.every((item) => item.variantId === 'evidence_reader_v3'));
  assert.ok(prepared.every((item) => item.blindLabel === '候选 v3'));
  assert.ok(prepared.every((item) => item.parameters.thinking.type === 'disabled'));
  assert.ok(prepared.every((item) => !('tools' in item.parameters)));
  assert.match(prepared[0].systemPrompt, /有来源边界的候选证据/u);
  assert.match(prepared[0].systemPrompt, /开头两三句话直接给出全景和结论/u);
  assert.match(prepared[0].systemPrompt, /JSON 字符串里必须写成双反斜杠/u);
});

test('blind order is stable for a run seed and changes for another seed', () => {
  assert.deepEqual(createBlindPromptOrder('same-run'), createBlindPromptOrder('same-run'));
  assert.notDeepEqual(createBlindPromptOrder('same-run'), createBlindPromptOrder('different-run'));
});

test('diagnoses valid structured Markdown without interpreting semantic quality as fact', () => {
  const output = JSON.stringify({
    answerMarkdown: '## 直接回答\n这是一个足够长的回答，用来解释核心概念、直觉和边界。'.repeat(4) + '\n\n$$y=x^2$$',
    keyPoints: [{
      title: '关键点',
      subtitle: '说明',
      importance: 8,
      importanceReason: '它决定是否能继续理解当前问题。',
      relationToFocus: 'support',
      documentMarkdown: '# 关键点\n\n内容',
    }],
  });
  const diagnostic = diagnosePromptLabOutput(output);
  assert.equal(diagnostic.validJson, true);
  assert.equal(diagnostic.hasCompleteAnswer, true);
  assert.equal(diagnostic.importanceValid, true);
  assert.equal(diagnostic.markdownFormulaLikelyValid, true);
  assert.equal(diagnostic.leakedInternalField, false);
  assert.deepEqual(diagnostic.warnings, []);
});

test('flags JSON control escapes that damaged LaTeX and repairs only the human-readable report', () => {
  const damagedTheta = `$${'\t'}heta$`;
  const content = JSON.stringify({
    answerMarkdown: `## 直接回答\n${'这是足够长的回答，用来解释角度、直觉和边界。'.repeat(5)}\n\n辐角是 ${damagedTheta}。`,
    keyPoints: [{
      title: '复数辐角',
      subtitle: '角度表示',
      importance: 8,
      importanceReason: '它决定如何理解复数的旋转。',
      relationToFocus: 'prerequisite',
      documentMarkdown: `## 直觉\n\n当 ${damagedTheta} 增大时，复数沿单位圆旋转。`,
    }],
  });
  const diagnostic = diagnosePromptLabOutput(content);
  assert.equal(diagnostic.validJson, true);
  assert.equal(diagnostic.markdownFormulaLikelyValid, false);
  assert.match(diagnostic.warnings.join('；'), /检测到 2 处 JSON 转义破坏的 LaTeX/u);

  const report = formatPromptLabRunMarkdown(promptLabRunFixture(content, diagnostic));
  assert.equal(report.includes('\t'), false);
  assert.equal(countOccurrences(report, '$\\theta$'), 2);
  assert.match(report, /结构诊断：检测到 2 处 JSON 转义破坏的 LaTeX/u);
});

test('uses the documented worst-case cache-miss domestic price formula', () => {
  assert.equal(estimateMimoCostCny(1_000_000, 1_000_000), 3);
  assert.equal(estimateMimoCostCny(10_000, 2_000), 0.014);
});

test('freezes the paid-run authorization gate with a conservative input ceiling', () => {
  const gate = estimatePromptLabGate('prompt-lab-gate-v1');
  assert.equal(gate.calls, 3);
  assert.equal(gate.maximumOutputTokens, 12_288);
  assert.ok(gate.maximumEstimatedCostCny < 0.04);
  assert.ok(gate.maximumInputTokens > gate.estimatedInputTokens);
});

test('renders a human reading report without dumping valid JSON into the Markdown body', () => {
  const content = JSON.stringify({
    answerMarkdown: '## 直接回答\n\n缩放用于避免点积随着维度变大。',
    keyPoints: [{
      title: '方差增长',
      subtitle: '维度越高，点积波动越大',
      importance: 9,
      importanceReason: '它连接了维度与 softmax 饱和。',
      relationToFocus: 'support',
      documentMarkdown: '## 直觉\n\n先看每一维贡献如何累加。',
    }],
  });
  const report = formatPromptLabRunMarkdown({
    format: 'learnstuff-prompt-lab-run',
    version: 3,
    runId: 'readable-v3',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:01.000Z',
    status: 'completed',
    provider: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5', thinking: 'disabled', retries: 0 },
    price: { currency: 'CNY', effectiveDate: '2026-07-15', cacheMissInputPerMillion: 1, outputPerMillion: 2 },
    gate: estimatePromptLabGate('readable-v3'),
    blindLabels: ['候选 v3'],
    completedCalls: 1,
    totalInputTokens: 100,
    totalOutputTokens: 200,
    totalEstimatedCostCny: 0.0005,
    results: [{
      index: 1,
      caseId: 'formula',
      caseTitle: '公式题：缩放因子',
      blindLabel: '候选 v3',
      status: 'succeeded',
      contextFingerprint: 'cp1-readable',
      content,
      diagnostic: diagnosePromptLabOutput(content),
      actualModel: 'mimo-v2.5',
      providerResponseId: 'response-redacted',
      inputTokens: 100,
      outputTokens: 200,
      cachedInputTokens: 0,
      latencyMs: 500,
      estimatedCostCny: 0.0005,
      error: null,
      codexScore: null,
      userScore: null,
    }],
    storage: { jsonUri: 'file:///audit.json', markdownUri: 'file:///report.md' },
  } satisfies PromptLabRun);
  assert.match(report, /### 回答[\s\S]*缩放用于避免点积/u);
  assert.match(report, /#### 1\. 方差增长 · 9\/10/u);
  assert.match(report, /为什么重要：它连接了维度与 softmax 饱和/u);
  assert.doesNotMatch(report, /```json/u);
  assert.doesNotMatch(report, /"answerMarkdown"/u);
});

function promptLabRunFixture(
  content: string,
  diagnostic: ReturnType<typeof diagnosePromptLabOutput>,
): PromptLabRun {
  return {
    format: 'learnstuff-prompt-lab-run',
    version: 3,
    runId: 'math-repair-v3',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:01.000Z',
    status: 'completed',
    provider: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5', thinking: 'disabled', retries: 0 },
    price: { currency: 'CNY', effectiveDate: '2026-07-15', cacheMissInputPerMillion: 1, outputPerMillion: 2 },
    gate: estimatePromptLabGate('math-repair-v3'),
    blindLabels: ['候选 v3'],
    completedCalls: 1,
    totalInputTokens: 100,
    totalOutputTokens: 200,
    totalEstimatedCostCny: 0.0005,
    results: [{
      index: 1,
      caseId: 'prerequisite',
      caseTitle: '前置题',
      blindLabel: '候选 v3',
      status: 'succeeded',
      contextFingerprint: 'cp1-math-repair',
      content,
      diagnostic,
      actualModel: 'mimo-v2.5',
      providerResponseId: 'response-redacted',
      inputTokens: 100,
      outputTokens: 200,
      cachedInputTokens: 0,
      latencyMs: 500,
      estimatedCostCny: 0.0005,
      error: null,
      codexScore: null,
      userScore: null,
    }],
    storage: { jsonUri: 'file:///audit.json', markdownUri: 'file:///report.md' },
  };
}

function countOccurrences(value: string, needle: string) {
  return value.split(needle).length - 1;
}

test('does not claim that an HTTP failure without model content passed structure diagnostics', () => {
  const report = formatPromptLabRunMarkdown({
    format: 'learnstuff-prompt-lab-run',
    version: 3,
    runId: 'failed-v3',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:01.000Z',
    status: 'failed',
    provider: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5', thinking: 'disabled', retries: 0 },
    price: { currency: 'CNY', effectiveDate: '2026-07-15', cacheMissInputPerMillion: 1, outputPerMillion: 2 },
    gate: estimatePromptLabGate('failed-v3'),
    blindLabels: ['候选 v3'],
    completedCalls: 1,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCostCny: 0,
    results: [{
      index: 1,
      caseId: 'formula',
      caseTitle: '公式题：缩放因子',
      blindLabel: '候选 v3',
      status: 'failed',
      contextFingerprint: 'cp1-failed',
      content: null,
      diagnostic: null,
      actualModel: null,
      providerResponseId: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      latencyMs: null,
      estimatedCostCny: null,
      error: { code: 'prompt_lab_http_401', message: 'MiMo 拒绝请求（HTTP 401）', outcomeUnknown: false },
      codexScore: null,
      userScore: null,
    }],
    storage: { jsonUri: 'file:///audit.json', markdownUri: 'file:///report.md' },
  } satisfies PromptLabRun);
  assert.match(report, /结构诊断：未获得响应，无法诊断/u);
  assert.match(report, /Codex 评分：不评分/u);
  assert.doesNotMatch(report, /结构诊断：通过/u);
});
