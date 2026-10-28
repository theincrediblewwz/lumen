// Selected real library UI, synthetic storage only. Never resolves credentials or calls a Provider.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.LSQ_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.LSQ_UI_URL || 'http://127.0.0.1:5198', output = process.env.LSQ_UI_EVIDENCE || 'output/playwright';
fs.mkdirSync(output, { recursive: true });
const checks = [], errors = [];
let browser, page;
const url = `${base}/scripts/knowledge-ui-fixture.html?platform=macos&nodes=1&captureQA=1&knowledgeDesignQA=1`;
const load = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('knowledge_load', {}));
const entries = () => page.locator('.knowledge-entry');
const body = () => page.getByRole('textbox', { name: '知识正文', exact: true });
const reading = () => page.locator('.knowledge-reading .md-body');
const more = () => page.getByLabel('知识库更多操作', { exact: true }).click();
async function open(extra = '') {
  await page.goto(url + extra);
  await page.getByRole('button', { name: '桌面夹', exact: true }).click();
  await page.locator('.pane-boards .list-item').filter({ hasText: '注意力学习' }).click();
  await page.getByRole('button', { name: '知识库', exact: true }).click(); await reading().waitFor();
}
async function theme(value) { await page.evaluate(async theme => { const { DEFAULT_SETTINGS, applySettings } = await import('/src/settings.ts'); applySettings({ ...DEFAULT_SETTINGS, theme, glass: false }, 'macos'); }, value); }
async function capture(name) { await page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' }); }
async function deepLink(entryId, revisionId, draft) { await page.evaluate(detail => window.dispatchEvent(new CustomEvent('lumen:open-knowledge', { detail })), { entryId, revisionId, draft }); }
(async () => {
  const engine = process.env.LSQ_UI_BROWSER || 'chromium';
  browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ...(engine === 'chromium' && process.env.LSQ_UI_CHANNEL ? { channel: process.env.LSQ_UI_CHANNEL } : {}) });
  page = await browser.newPage({ viewport: { width: 1487, height: 1058 } }); page.setDefaultTimeout(16000);
  page.on('pageerror', e => errors.push(e.message));
  await open(); await theme('light'); await page.locator('.katex').first().waitFor();
  assert.equal(await page.locator('.sidebar').isVisible(), false);
  assert.equal(await entries().count(), 6); assert.equal(await page.locator('.knowledge-entry[aria-pressed=true]').innerText(), '我的理解\n我怎样理解注意力');
  assert.equal(await page.locator('.knowledge-reference-bar').innerText(), '用于白板 · 注意力学习\n引用到白板\nAI引用：关闭');
  assert.equal(await page.locator('.math-error').count(), 0);
  assert.equal(await reading().evaluate(el => getComputedStyle(el).fontWeight), '400');
  assert.ok(await reading().locator(':scope > p').first().evaluate(el => el.getBoundingClientRect().width <= 680));
  assert.equal(await page.locator('.knowledge-workspace').evaluate(el => getComputedStyle(el).webkitFontSmoothing), 'antialiased');
  await capture('knowledge-selected-desktop'); checks.push('selected split layout owns the workspace with six indexed entries, real article, provenance and rendered formula');
  for (const value of ['light', 'paper', 'dark']) for (const width of [1440, 1024, 720, 440, 380]) {
    await page.setViewportSize({ width, height: 820 }); await theme(value);
    assert.equal(await page.locator('.knowledge-workspace').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await page.locator('.knowledge-columns').evaluate(el => getComputedStyle(el).flexDirection), width > 780 ? 'row' : 'column');
    for (const label of ['返回白板', '写下理解']) { const box = await page.getByRole('button', { name: label, exact: true }).boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, label); }
    await capture(`knowledge-${value}-${width}`);
  }
  checks.push('three themes at five widths retain readable labels, reachable primary controls and no horizontal overflow');
  await page.setViewportSize({ width: 1487, height: 1058 }); await theme('light');
  await page.getByRole('textbox', { name: '搜索知识', exact: true }).fill('第 2 页'); assert.equal(await entries().count(), 1); assert.ok((await reading().innerText()).includes('相关性'));
  await page.getByRole('textbox', { name: '搜索知识', exact: true }).fill('不存在的关键词'); assert.equal(await entries().count(), 0); assert.equal(await reading().count(), 0);
  await more(); await page.locator('.knowledge-global-policy').getByRole('radio', { name: '不引用', exact: true }).check(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await page.getByRole('group', { name: '知识类型筛选', exact: true }).getByRole('button', { name: '经验', exact: true }).click(); assert.equal(await entries().count(), 2);
  await page.getByRole('group', { name: '知识类型筛选', exact: true }).getByRole('button', { name: '全部', exact: true }).click();
  checks.push('source/body search and kind filters keep reader selection consistent; permission remains reachable in an empty result');
  await page.getByRole('button', { name: '写下理解', exact: true }).click();
  await page.getByRole('textbox', { name: '知识标题', exact: true }).fill('我的新理解'); await body().fill('不能丢失的草稿。');
  await page.getByRole('textbox', { name: '搜索知识', exact: true }).fill('材料'); assert.equal(await body().inputValue(), '不能丢失的草稿。');
  await entries().first().click(); await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await body().inputValue(), '不能丢失的草稿。');
  await page.getByRole('button', { name: '返回白板', exact: true }).click();
  await page.keyboard.press('Backspace'); assert.equal(page.url(), url); await page.keyboard.press('Escape'); assert.equal(await body().inputValue(), '不能丢失的草稿。');
  await page.getByRole('button', { name: '保存', exact: true }).click(); await page.locator('.knowledge-reading h2').filter({ hasText: '我的新理解' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '搜索知识', exact: true }).inputValue(), '');
  let snapshot = await load(); const saved = snapshot.library.entries.find(row => row.title === '我的新理解');
  checks.push('search, entry switching and return cannot discard an unsaved draft; successful saving reveals the new entry');
  await page.getByRole('button', { name: '引用到白板', exact: true }).click(); await page.getByRole('button', { name: '解除引用', exact: true }).waitFor();
  snapshot = await load(); assert.equal(snapshot.library.bindings.find(row => row.entry_id === saved.id).project_id, 'board');
  assert.equal(snapshot.library.settings.find(row => row.project_id === 'board')?.policy ?? 'disabled', 'disabled');
  assert.ok((await page.locator('.knowledge-bound-note').innerText()).includes('仍关闭'));
  await page.getByLabel('白板引用设置', { exact: true }).click(); await page.locator('.knowledge-policy').getByRole('radio', { name: '允许按问题检索', exact: true }).check();
  await page.keyboard.press('Escape'); assert.ok((await page.getByLabel('白板引用设置', { exact: true }).innerText()).includes('按需'));
  await page.evaluate(() => { localStorage.setItem('lumen.ai.v1', JSON.stringify({ shareBoard: false })); window.dispatchEvent(new StorageEvent('storage', { key: 'lumen.ai.v1' })); });
  await page.waitForFunction(() => document.querySelector('.knowledge-policy summary').textContent.includes('读取未开启'));
  assert.equal(await page.evaluate(() => window.__fixtureSecretAccess.length), 0);
  await page.evaluate(() => { localStorage.setItem('lumen.ai.v1', JSON.stringify({ shareBoard: true })); window.dispatchEvent(new StorageEvent('storage', { key: 'lumen.ai.v1' })); });
  checks.push('linking uses board ID, never enables AI implicitly, and effective status reflects global sharing without reading a credential');
  await page.getByRole('button', { name: '编辑', exact: true }).click(); await body().fill('这是后来的新理解。'); await page.getByRole('button', { name: '保存', exact: true }).click(); await body().waitFor({ state: 'hidden' });
  await deepLink(saved.id, saved.revision_id); await page.getByText('我的理解 · 当时的引用版本', { exact: true }).waitFor(); assert.ok((await reading().innerText()).includes('不能丢失的草稿'));
  await more(); await page.locator('.knowledge-global-policy').getByRole('radio', { name: '不引用', exact: true }).check(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '当前版本', exact: true }).click(); assert.ok((await reading().innerText()).includes('后来的新理解'));
  await deepLink(saved.id, 'missing_revision'); await page.getByText('引用版本尚未到齐，请同步完整知识库后再打开。', { exact: true }).waitFor(); assert.equal(await reading().count(), 0);
  await deepLink(saved.id); await reading().waitFor(); checks.push('historical deep links keep immutable text, missing revisions never fall back, and board policy stays available');
  await page.getByLabel('条目更多操作', { exact: true }).click(); await page.getByRole('button', { name: '归档', exact: true }).click(); await page.locator('.knowledge-archived-note').waitFor();
  await page.getByRole('button', { name: '解除引用', exact: true }).click(); assert.equal(await page.getByRole('button', { name: '引用到白板', exact: true }).isDisabled(), true);
  await page.getByLabel('条目更多操作', { exact: true }).click(); await page.getByRole('button', { name: '恢复到列表', exact: true }).click(); await page.locator('.knowledge-archived-note').waitFor({ state: 'hidden' });
  checks.push('archive preserves the article and history, exposes real status and supports restoration without permitting a useless new archived binding');
  await page.getByRole('button', { name: '编辑', exact: true }).click(); await body().fill('失败也应保留这段。'); await page.evaluate(() => { window.__fixtureKnowledgeSaveFailure = true; });
  await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '合成知识保存失败' }).waitFor(); assert.equal(await body().inputValue(), '失败也应保留这段。');
  await page.evaluate(() => { window.__fixtureKnowledgeSaveFailure = false; });
  await page.getByRole('button', { name: '重新加载资料（保留草稿）', exact: true }).click(); assert.equal(await body().inputValue(), '失败也应保留这段。');
  await page.evaluate(() => { window.__fixtureKnowledgeSaveDelay = 400; }); await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.knowledge-body-input').disabled); await page.getByRole('button', { name: '返回白板', exact: true }).click();
  assert.equal(await body().count(), 1); await body().waitFor({ state: 'hidden' });
  checks.push('failed writes and reload keep drafts; delayed saves lock editing and refuse navigation until completion');
  await deepLink(undefined, undefined, { title: 'AI摘录', body: '需要明确采用的回答。', source: '合成对话', authorship: 'ai_adopted' });
  await page.getByRole('button', { name: '采用并保存', exact: true }).click(); await page.getByText('AI 内容 · 已由你采用', { exact: true }).waitFor();
  checks.push('AI-origin drafts retain provenance and require explicit adoption');
  await more(); await page.getByRole('button', { name: '导出知识库', exact: true }).click(); await page.waitForFunction(() => window.__fixtureExports.length === 1);
  const count = (await load()).library.entries.length;
  await more(); await page.getByRole('button', { name: '导入知识副本', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click(); assert.equal((await load()).library.entries.length, count);
  await more(); await page.getByRole('button', { name: '导入知识副本', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click(); await page.waitForFunction(count => JSON.parse(localStorage.getItem('lumen.fixture-knowledge-design')).entries.length === count * 2, count);
  checks.push('export reaches the native command; import cancellation preserves storage and approval adds independent copies');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click(); assert.equal(await page.getByRole('complementary', { name: '知识索引', exact: true }).isVisible(), false);
  await page.getByRole('button', { name: '返回白板', exact: true }).click(); assert.equal(await page.locator('.sidebar.has-boards').isVisible(), true); assert.equal(await page.locator('.node-card').count(), 1);
  await page.reload(); await page.getByRole('button', { name: '知识库', exact: true }).click(); await reading().waitFor(); assert.equal((await load()).library.entries.length, count * 2);
  assert.equal(await page.getByRole('button', { name: '引用到白板', exact: true }).count(), 0); checks.push('return restores original board navigation; saved knowledge survives reload and stays independent without a selected board');
  await open('&restrictedKnowledge=1'); await more(); await page.locator('.knowledge-global-policy').getByRole('radio', { name: '允许按问题检索', exact: true }).check(); await page.keyboard.press('Escape');
  assert.ok((await page.getByLabel('白板引用设置', { exact: true }).innerText()).includes('资料范围受限'));
  assert.equal(await page.evaluate(() => window.__fixtureSecretAccess.length), 0); checks.push('source-limited boards report the effective restriction and library browsing performs no credential reads');
  assert.deepEqual(errors, []); fs.writeFileSync(path.join(output, 'knowledge-library-qa.json'), JSON.stringify({ checks, errors, realProviderCalls: 0, realCredentialsRead: 0 }, null, 2));
  await browser.close(); console.log(JSON.stringify({ pass: true, checks: checks.length, output }));
})().catch(async error => { if (page) { await capture('knowledge-library-failure').catch(() => {}); fs.writeFileSync(path.join(output, 'knowledge-library-failure.txt'), await page.locator('body').ariaSnapshot().catch(() => '')); } if (browser) await browser.close(); console.error(error); process.exitCode = 1; });
