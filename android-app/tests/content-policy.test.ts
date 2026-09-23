import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProjectContentPolicy,
  resolveContentContract,
} from '../ai/content-policy';
import {
  decodeMarkdownMathPayload,
  MARKDOWN_MATH_ACCEPTANCE_SAMPLE,
  MARKDOWN_MATH_SENTINEL,
  normalizeMarkdownMath,
  prepareMarkdownMathForRenderer,
} from '../ai/markdown-math';

test('summary contract is source-bounded by default and only exposes summary relations', () => {
  const contract = resolveContentContract(createProjectContentPolicy({ mode: 'summary' }));
  assert.equal(contract.sourceBoundary, 'source_bounded');
  assert.deepEqual(contract.allowedRelations, ['contains', 'evidence', 'support', 'analogy', 'counterexample']);
  assert.match(contract.instruction, /资料中没有/u);
  assert.doesNotMatch(contract.allowedRelations.join(','), /prerequisite/u);
});

test('learning contract keeps prerequisite semantics and marks uncertainty', () => {
  const contract = resolveContentContract(createProjectContentPolicy({ mode: 'learning', detailLevel: 'deep' }));
  assert.equal(contract.sourceBoundary, 'learning_open');
  assert.equal(contract.allowedRelations.includes('prerequisite'), true);
  assert.match(contract.instruction, /不确定/u);
  assert.match(contract.instruction, /超过 1800/u);
});

test('legacy math delimiters normalize without changing canonical delimiters', () => {
  const normalized = normalizeMarkdownMath(MARKDOWN_MATH_ACCEPTANCE_SAMPLE);
  assert.match(normalized, /\$a\^2\+b\^2=c\^2\$/u);
  assert.match(normalized, /\$\$[\s\S]*\\frac/u);
  assert.match(normalized, /\\begin\{bmatrix\}/u);
  assert.equal(normalized.includes('\\('), false);
  assert.equal(normalized.includes('\\['), false);
});

test('math is protected before Markdown block and inline parsing without treating currency as TeX', () => {
  const protectedMarkdown = prepareMarkdownMathForRenderer([
    '行内 $QK^\\mathsf{T} / \\sqrt{d_k}$。',
    '',
    '$$',
    '\\operatorname{Attention}(Q,K,V)',
    '=',
    '\\operatorname{softmax}(QK^\\mathsf{T})V',
    '$$',
    '',
    '价格 $12.50 不应变成公式，`$code$` 也不应变。',
  ].join('\n'));

  assert.match(protectedMarkdown, new RegExp(`${MARKDOWN_MATH_SENTINEL}inline:`, 'u'));
  assert.match(protectedMarkdown, new RegExp(`${MARKDOWN_MATH_SENTINEL}display:`, 'u'));
  assert.equal(protectedMarkdown.includes('\n=\n'), false);
  assert.match(protectedMarkdown, /\$12\.50/u);
  assert.match(protectedMarkdown, /`\$code\$`/u);

  const encoded = protectedMarkdown.match(/display:([^`]+)/u)?.[1];
  assert.ok(encoded);
  assert.match(decodeMarkdownMathPayload(encoded), /\\operatorname\{Attention\}/u);
});
