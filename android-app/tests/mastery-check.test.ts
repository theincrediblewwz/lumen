import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMasteryPrompt } from '../data/mastery-check';

test('extracts structured self-check question and reference sections', () => {
  const prompt = buildMasteryPrompt('注意力', '# 注意力\n\n## 直觉\n按相关性聚合。\n\n## 自检问题\n为什么要区分 Q 和 K？\n\n## 自检参考\nQ 表示寻找目标，K 表示可匹配特征。');
  assert.equal(prompt.question, '为什么要区分 Q 和 K？');
  assert.equal(prompt.reference, 'Q 表示寻找目标，K 表示可匹配特征。');
  assert.equal(prompt.usedFallbackQuestion, false);
  assert.equal(prompt.usedFallbackReference, false);
});

test('builds an answer-first fallback without claiming automated grading', () => {
  const prompt = buildMasteryPrompt('向量', '# 向量\n\n## 直觉\n向量可以表示有方向的量。');
  assert.match(prompt.question, /自己的话解释/);
  assert.match(prompt.reference, /向量可以表示/);
  assert.equal(prompt.usedFallbackQuestion, true);
  assert.equal(prompt.usedFallbackReference, true);
});
