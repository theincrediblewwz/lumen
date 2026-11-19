const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webkit } = require(process.env.LSQ_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.LSQ_UI_URL || 'http://127.0.0.1:5198';
const evidence = path.resolve(process.env.LSQ_UI_EVIDENCE || 'mac-ui-evidence');

(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  const browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const checks = [], errors = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const button = (name, parent = page) => parent.getByRole('button', { name, exact: true });
  const card = name => button(name, page.locator('.project-canvas'));
  const crumb = name => button(name, page.getByRole('navigation', { name: '项目路径' }));
  const eye = () => button('按标签筛选');
  const options = page.locator('.catalog-filter-panel');
  const tag = name => button(name, options);
  const menuItem = name => page.getByRole('menuitem', { name, exact: true });
  const dialog = () => page.getByRole('dialog', { name: '编辑标签', exact: true });
  const relation = page.locator('.project-relation-hit');
  const label = page.getByRole('textbox', { name: '项目连线名称', exact: true });
  const draft = '应用到这篇论文 $\\nu^2$';
  const custom = '重点复核';
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('lumen.fixture-navigation')));
  const snapshot = name => page.screenshot({ path: path.join(evidence, `catalog-tags-${name}.png`), animations: 'disabled' });
  const check = text => { checks.push(text); console.log(text); };
  const tagItem = async (item, tags) => {
    await item.click({ button: 'right' });
    await menuItem('编辑标签…').click();
    for (const choice of tags) await button(choice, dialog()).click();
  };
  const saveTags = async () => {
    await button('保存', dialog()).click();
    await dialog().waitFor({ state: 'hidden' });
  };
  const editEdge = async () => {
    const { x, y } = await relation.evaluate(line => {
      const point = line.getPointAtLength(line.getTotalLength() / 2).matrixTransform(line.getScreenCTM());
      return { x: point.x, y: point.y };
    });
    await page.mouse.click(x, y);
    await label.waitFor();
  };
  const node = id => page.locator(`.board-canvas-live .node-card[data-node-id="${id}"]`);

  try {
    const address = base + '/scripts/knowledge-ui-fixture.html?mode=main&platform=macos&catalogTagsQA=1';
    await page.goto(address);
    assert.equal(page.url(), address);
    assert.match(await page.title(), /合成页面验收/);
    await card('理论').waitFor();
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    await editEdge();
    await label.fill(draft); await label.press('Enter');
    const rendered = page.locator('.project-relation-names .edge-label-rendered');
    await rendered.locator('.katex').waitFor();
    assert.ok(await rendered.getByText('应用到这篇论文', { exact: false }).count());
    assert.equal((await state()).layout.relations[0].label, draft);
    await rendered.click(); await label.fill('取消的草稿'); await label.press('Escape');
    assert.equal((await state()).layout.relations[0].label, draft);
    check('one click edits the arrow or its name, rendered KaTeX is visible, and Escape keeps the saved name');

    await rendered.click(); await label.fill('应用到这篇论文 $\\nu_1$');
    await page.evaluate(() => { window.__fixtureNavigationFailure = true; });
    await label.press('Enter');
    await page.getByRole('alert').filter({ hasText: '合成磁盘写入失败' }).waitFor();
    assert.equal((await state()).layout.relations[0].label, draft);
    assert.match(await label.inputValue(), /_1/);
    await page.evaluate(() => { window.__fixtureNavigationFailure = false; });
    await button('保存连线名称').click();
    await label.waitFor({ state: 'hidden' });
    assert.match((await state()).layout.relations[0].label, /_1/);
    check('a failed label write keeps the draft and allows a successful retry');

    await tagItem(card('理论'), ['红色']);
    await button('新建标签', dialog()).click();
    await dialog().getByRole('textbox', { name: '标签名称' }).fill(custom);
    await dialog().locator('input[type=color]').fill('#5b7ec4');
    await button('添加', dialog()).click();
    await saveTags();
    await tagItem(card('论文'), ['蓝色']); await saveTags();
    const saved = (await state()).layout.tags;
    const customId = Object.keys(saved.definitions)[0];
    assert.deepEqual(saved.definitions[customId], { name: custom, color: '#5b7ec4' });
    assert.deepEqual(saved.assignments.project, ['color_red', customId]);
    assert.deepEqual(saved.assignments['project-other'], ['color_blue']);
    check('folders accept multiple built-in and custom tags with a user-chosen color');

    const before = await card('理论').boundingBox();
    await eye().click(); await tag(custom).click();
    await card('论文').waitFor({ state: 'detached' });
    assert.equal(await relation.count(), 0);
    await tag('蓝色').click(); await card('论文').waitFor();
    await tag('全部内容').click();
    assert.deepEqual(await card('理论').boundingBox(), before);
    await rendered.locator('.katex').waitFor();
    await snapshot('home');
    await tag(custom).click();
    await card('理论').dblclick();
    await card('研究白板').waitFor();
    await eye().click(); assert.equal(await tag('全部内容').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Escape');
    check('the eye combines selected tags, restores all content without shifting it, and keeps levels independent');

    await tagItem(card('研究白板'), [custom]); await saveTags();
    await eye().click(); await tag(custom).click();
    await card('备用白板').waitFor({ state: 'detached' });
    await card('研究白板').click();
    await node('blue').waitFor();
    const boardBefore = (await state()).boards.find(board => board.id === 'board');
    await eye().click(); await tag('蓝色').click();
    await node('review').waitFor({ state: 'detached' });
    assert.equal(await node('blue').count(), 1);
    await tag('全部内容').click();
    await node('review').waitFor();
    await page.keyboard.press('Escape');
    check('board cards are taggable, and old node color markings filter without a migration');

    await node('review').click();
    await page.locator('.node-panel').waitFor();
    await page.locator('.node-tag-edit').click();
    await button(custom, dialog()).click(); await saveTags();
    await node('flow').click();
    const flow = page.locator('.flow-panel');
    await flow.waitFor();
    await tagItem(flow.locator('[data-flow-step="step_two"] .node-card'), [custom]);
    await saveTags();
    await eye().click(); await tag(custom).click();
    await node('blue').waitFor({ state: 'detached' });
    assert.equal(await node('review').count(), 1);
    assert.equal(await node('plain').count(), 0);
    assert.equal(await flow.locator('[data-flow-step="step_one"]').count(), 0);
    assert.equal(await flow.locator('[data-flow-step="step_two"] .flow-step-number').innerText(), '2');
    await tag('全部内容').click();
    await flow.locator('[data-flow-step="step_one"]').waitFor();
    const boardAfter = (await state()).boards.find(board => board.id === 'board');
    assert.deepEqual(boardBefore.nodes, boardAfter.nodes);
    assert.deepEqual(boardBefore.edges, boardAfter.edges);
    check('main and flow nodes can use named tags, and filtering preserves hidden steps and the full saved graph');

    await crumb('项目首页').click();
    await card('理论').waitFor();
    await page.reload();
    await card('理论').waitFor();
    await rendered.locator('.katex').waitFor();
    assert.ok((await state()).layout.tags.assignments['project/board/review'].includes(customId));
    await eye().click();
    assert.equal(await tag(custom).count(), 1);
    await page.setViewportSize({ width: 720, height: 480 });
    await page.evaluate(async () => {
      const { DEFAULT_SETTINGS, applySettings } = await import('/src/settings.ts');
      applySettings({ ...DEFAULT_SETTINGS, theme: 'dark', glass: false }, 'macos');
    });
    const bounds = await options.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 720 && bounds.y + bounds.height <= 480);
    await snapshot('720-dark');
    assert.deepEqual(errors, []);
    check('reopening retains named arrows and tags, and the dark filter fits a 720×480 window');
    fs.writeFileSync(path.join(evidence, 'catalog-tags-qa.json'), JSON.stringify({ checks, errors, realProviderCalls: 0 }, null, 2));
  } catch (error) {
    await snapshot('failure').catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
