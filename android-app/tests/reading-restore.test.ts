import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceReadingRestore, beginReadingRestore, firstReadingIndex, READING_RESTORE_INTERVAL_MS, READING_RESTORE_MAX_ATTEMPTS, READING_RESTORE_WINDOW_MS, readingBlocks, restoreReadingIndex, type ReadingRestorePlan } from '../data/reading-position';

test('restoration replaces an estimated successful index scroll with the measured native cell offset', () => {
  let plan: ReadingRestorePlan | null = beginReadingRestore(34, 1000);
  let step = advanceReadingRestore(plan, 1000, undefined, 0);
  assert.deepEqual(step.command, { type: 'index', index: 34 }); plan = step.plan;
  // FlatList reported no failure, but its average heights left chapter five visible.
  step = advanceReadingRestore(plan, 1180, { y: 3220, height: 140 }, 2500);
  assert.deepEqual(step.command, { type: 'offset', offset: 3220 }); plan = step.plan;
  step = advanceReadingRestore(plan, 1360, { y: 3220, height: 140 }, 3220);
  assert.equal(step.command, null); assert.ok(step.plan);
});

test('late TeX height changes are corrected after initial alignment without restarting an unbounded timer', () => {
  let step = advanceReadingRestore(beginReadingRestore(34, 0), 0, { y: 3220, height: 140 }, 3220);
  assert.equal(step.command, null); const originalDeadline = step.plan!.deadline;
  step = advanceReadingRestore(step.plan, 2000, { y: 3440, height: 140 }, 3220);
  assert.deepEqual(step.command, { type: 'offset', offset: 3440 }); assert.equal(step.plan!.deadline, originalDeadline);
  step = advanceReadingRestore(step.plan, READING_RESTORE_WINDOW_MS, { y: 3600, height: 140 }, 3440);
  assert.equal(step.plan, null); assert.equal(step.command, null);
});

test('user cancellation prevents every later layout callback or scheduled retry from moving the page', () => {
  const cancelled: ReadingRestorePlan | null = null;
  for (const now of [0, 180, 500, 3000]) {
    assert.deepEqual(advanceReadingRestore(cancelled, now, { y: 3200, height: 100 }, 800), { plan: null, command: null });
  }
});

test('missing or unstable cells have a fixed retry ceiling and repeated layout notifications cannot flood scroll commands', () => {
  let plan: ReadingRestorePlan | null = beginReadingRestore(80, 0); let commands = 0;
  for (let index = 0; index < 100; index++) {
    const now = index * READING_RESTORE_INTERVAL_MS;
    const step = advanceReadingRestore(plan, now, undefined, 0); plan = step.plan; if (step.command) commands++;
    assert.equal(advanceReadingRestore(plan, now + 1, undefined, 0).command, null);
  }
  assert.equal(commands, READING_RESTORE_MAX_ATTEMPTS); assert.equal(plan, null);
});

test('a sliver of the previous block does not replace the target heading anchor', () => {
  const frames = new Map([[29, { y: 900, height: 104 }], [30, { y: 1004, height: 70 }], [31, { y: 1074, height: 300 }]]);
  assert.equal(firstReadingIndex([31, 29, 30], frames, 1000), 30);
  assert.equal(firstReadingIndex([29, 30], frames, 950), 29);
  assert.equal(firstReadingIndex([], frames, 0), null);
});

test('the native twelve-section Markdown fixture keeps chapter-seven anchors distinct from repeated paragraph and TeX blocks', () => {
  const section = (index: number) => `## 第 ${index} 节：理解与练习\n\n这一段用于验证中文阅读、目录和跨次打开的阅读位置。\n\n$$\\sqrt{3^2+4^2}=5$$\n\n- 先理解条件\n- 再连接已有知识\n\n`;
  const markdown = '# 勾股定理\n\n直角三角形满足 $a^2+b^2=c^2$。\n\n' + Array.from({ length: 12 }, (_, index) => section(index + 1)).join('');
  const blocks = readingBlocks(markdown); const seventh = blocks.find(block => block.heading?.startsWith('第 7 节'))!;
  assert.ok(seventh); assert.equal(restoreReadingIndex(blocks, { anchor: seventh.anchor, ratio: 0.1 }), seventh.index);
  assert.equal(blocks.filter(block => block.heading?.startsWith('第 ')).length, 12);
  assert.equal(new Set(blocks.map(block => block.anchor)).size, blocks.length);
});
