// Real App/AiApp/ReaderApp with synthetic storage. Never invokes a Provider.
const { createRequire } = require('node:module');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, webkit } = createRequire(__filename)(process.env.LSQ_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.LSQ_UI_URL || 'http://127.0.0.1:5198';
const output = path.resolve(process.env.LSQ_UI_EVIDENCE || 'mac-ui-evidence');
mkdirSync(output, { recursive: true });
const errors = [], checks = [];
let browser;
async function theme(page, value) {
  await page.evaluate(async value => {
    const { DEFAULT_SETTINGS, applySettings } = await import('/src/settings.ts');
    applySettings({ ...DEFAULT_SETTINGS, theme: value, glass: false }, 'macos');
  }, value);
}
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
}
async function openFixture(page, address) {
  // Cold Vite transformation can exceed 30s on a new CI runner. Readiness is the
  // fixture parent's React effect, independent of fonts and the window load event.
  await page.goto(address, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__fixtureReactMounted === true);
}
async function withinViewport(page, locator) {
  const bounds = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, JSON.stringify(bounds));
}
(async () => {
  const engine = process.env.LSQ_UI_BROWSER || 'chromium';
  browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ...(engine === 'chromium' && process.env.LSQ_UI_CHANNEL ? { channel: process.env.LSQ_UI_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const fixture = mode => `${base}/scripts/knowledge-ui-fixture.html?platform=macos&mode=${mode}&project=project&board=board&name=Mac%E5%AD%A6%E4%B9%A0%E7%99%BD%E6%9D%BF&path=docs/sample.md&title=%E5%90%88%E6%88%90%E9%98%85%E8%AF%BB%E6%9D%90%E6%96%99`;
  for (const [mode, selector, controls, padding] of [
    ['main', '.titlebar', '.win-controls', '80px'],
    ['ai', '.ai-titlebar', '.ai-wincontrols', '78px'],
    ['reader', '.reader-bar', '.reader-wincontrols', '78px'],
  ]) {
    await openFixture(page, fixture(mode) + '&platformDelay=10000');
    await page.locator(mode === 'ai' ? '.ai-root.is-platform-pending' : selector + '.is-platform-pending').waitFor();
    assert.equal(await page.locator(controls).count(), 0);
    assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).paddingLeft), padding);
  }
  checks.push('main, AI and reader reserve native traffic lights while platform is pending; no Windows button flash');
  await openFixture(page, fixture('main'));
  await page.locator('.titlebar.is-mac').waitFor();
  assert.equal(await page.title(), '知识库合成页面验收');
  assert.ok(page.url().startsWith(base + '/scripts/knowledge-ui-fixture.html'));
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  await page.locator('.pane-projects .list-item').filter({ hasText: '桌面夹' }).click();
  await page.locator('.pane-boards .list-item').filter({ hasText: '合成学习白板' }).click();
  await page.locator('.knowledge-nav').click();
  await page.locator('.knowledge-reading article').waitFor();
  for (const value of ['light', 'paper', 'dark']) for (const width of [1280, 1024, 720]) {
    await page.setViewportSize({ width, height: 820 });
    await theme(page, value);
    assert.equal(await page.locator('.knowledge-workspace').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await withinViewport(page, page.getByRole('button', { name: '返回白板', exact: true }));
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    assert.equal(await page.locator('.knowledge-columns').evaluate(el => getComputedStyle(el).flexDirection), width > 780 ? 'row' : 'column');
    await screenshot(page, `mac-knowledge-${value}-${width}`);
  }
  checks.push('knowledge owns the workspace, hides both board sidebars and adapts its index at 780px; 3 themes at 1280/1024/720');
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.getByRole('button', { name: '写下理解', exact: true }).click();
  await page.getByRole('textbox', { name: '知识标题', exact: true }).fill('Mac 知识草稿');
  await page.getByRole('textbox', { name: '知识正文', exact: true }).fill('用户自己的理解，不调用 AI。');
  await page.getByRole('button', { name: '返回白板', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '知识标题', exact: true }).inputValue(), 'Mac 知识草稿');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.knowledge-reading h2').filter({ hasText: 'Mac 知识草稿' }).waitFor();
  await page.getByRole('button', { name: '返回白板', exact: true }).click();
  await page.locator('.knowledge-workspace').waitFor({ state: 'detached' });
  await page.locator('.knowledge-nav').click();
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  assert.equal(await page.getByRole('complementary', { name: '知识索引', exact: true }).isVisible(), false);
  await page.getByRole('button', { name: '返回白板', exact: true }).click();
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  await page.locator('.pane-boards .list-item').filter({ hasText: '第二块合成白板' }).click();
  await page.locator('.knowledge-workspace').waitFor({ state: 'detached' });
  checks.push('knowledge draft cancel/save, independent index collapse and explicit return restore the board navigation');
  await theme(page, 'paper');
  await screenshot(page, 'mac-board-paper');
  await page.getByRole('button', { name: '菜单', exact: true }).click();
  await page.locator('.ctx-item').filter({ hasText: '设置' }).click();
  await page.locator('.settings-card').waitFor();
  await screenshot(page, 'mac-settings-paper');
  await page.keyboard.press('Escape');
  await page.locator('.settings-card').waitFor({ state: 'detached' });
  checks.push('settings reuses original paper theme and closes with Escape');

  await openFixture(page, fixture('ai'));
  await page.locator('.ai-root.is-mac').waitFor();
  await page.getByRole('button', { name: '历史对话' }).click();
  await page.locator('.ai-history-item').click();
  await page.locator('.ai-msg-assistant').waitFor();
  assert.equal(await page.locator('.ai-wincontrols').count(), 0);
  await page.evaluate(async () => {
    const loaded = await window.__TAURI_INTERNALS__.invoke('knowledge_load');
    const entry = loaded.library.entries.find(row => row.kind === 'understanding');
    loaded.library.settings = [{ id: 'board', project_id: 'board', policy: 'priority', updated_at: new Date().toISOString() }];
    loaded.library.bindings = [{ id: 'mac-qa', project_id: 'board', entry_id: entry.id, node_id: null, created_at: new Date().toISOString() }];
    await window.__TAURI_INTERNALS__.invoke('knowledge_save', { library: loaded.library, expectedRevision: loaded.revision });
  });
  await page.getByRole('textbox', { name: '输入问题' }).fill('怎样依据我自己的理解继续思考？');
  await theme(page, 'paper');
  await screenshot(page, 'mac-ai-paper');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('dialog', { name: '本次知识引用' }).waitFor();
  assert.equal(await page.locator('.ai-reference-list details').count(), 2);
  for (const value of ['light', 'paper', 'dark']) for (const [width, height] of [[520, 760], [380, 420]]) {
    await page.setViewportSize({ width, height });
    await theme(page, value);
    await withinViewport(page, page.getByRole('button', { name: '确认并发送', exact: true }));
    await withinViewport(page, page.getByRole('button', { name: '取消', exact: true }));
    assert.equal(await page.locator('.ai-root').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await screenshot(page, `mac-reference-${value}-${width}`);
  }
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '输入问题' }).inputValue(), '怎样依据我自己的理解继续思考？');
  checks.push('standalone AI and references remain rounded, readable and usable at 520x760/380x420 in 3 themes; cancel retains question');
  await openFixture(page, fixture('reader'));
  await page.locator('.reader-bar.is-mac').waitFor();
  assert.equal(await page.locator('.reader-wincontrols').count(), 0);
  for (const value of ['light', 'paper', 'dark']) {
    await page.setViewportSize({ width: 860, height: 900 });
    await theme(page, value);
    await screenshot(page, `mac-reader-${value}`);
    await page.setViewportSize({ width: 480, height: 400 });
    assert.equal(await page.locator('.reader').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  }
  checks.push('reader keeps original typography, paper colors and traffic-light inset in 3 themes, down to 480x400');
  assert.deepEqual(errors, []);
  const report = { environment: `${process.platform}, Playwright ${engine}, actual App/AiApp/ReaderApp with synthetic storage`, browserPlugin: 'Browser plugin not available; regular Playwright used', url: base, checks, errors, realProviderCalls: 0, nativeTauriUI: false };
  writeFileSync(path.join(output, 'mac-ui-qa.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
