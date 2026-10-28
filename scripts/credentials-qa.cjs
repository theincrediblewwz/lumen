/* Actual AI/settings components, synthetic native bridge only. No real key/provider. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require(process.env.LSQ_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.LSQ_UI_URL || 'http://127.0.0.1:5198';
const output = process.env.LSQ_UI_EVIDENCE || 'output/playwright';
fs.mkdirSync(output, { recursive: true });
let browser, page; const checks = [], errors = [];
const state = () => page.evaluate(() => ({ metadata: Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('lumen.ai.'))), vault: sessionStorage.getItem('lumen-fixture-secrets') }));
async function click(locator) { await locator.scrollIntoViewIfNeeded(); await locator.click(); }
async function settings() { await click(page.getByRole('button', { name: '设置', exact: true })); await page.getByRole('form', { name: 'AI 设置' }).waitFor(); }
async function shot(name) { await page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' }); }
(async () => {
  const engine = process.env.LSQ_UI_BROWSER || 'chromium';
  browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ...(engine === 'chromium' && process.env.LSQ_UI_CHANNEL ? { channel: process.env.LSQ_UI_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1040, height: 760 } }); page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const fixture = board => `${base}/scripts/knowledge-ui-fixture.html?mode=ai&platform=macos&project=project&board=${board || 'board'}&name=凭据验收&keychainQA=1`;
  await page.goto(fixture()); await page.locator('.ai-root.is-mac').waitFor();
  await page.evaluate(async () => {
    const { saveAiProfile, DEFAULT_AI_SETTINGS } = await import('/src/ai/aiSettings.ts');
    await saveAiProfile({ ...DEFAULT_AI_SETTINGS, keyStorage: 'system', apiKey: 'qa-old-key', shareBoard: false }, '原钥匙串配置');
  });
  await page.reload(); await page.locator('.ai-root.is-mac').waitFor(); await settings();
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('API Key', { exact: true }).getAttribute('placeholder'), '已保存，使用时读取');
  assert.equal(await page.getByLabel('密钥保存', { exact: true }).inputValue(), 'system');
  assert.deepEqual(await page.evaluate(() => window.__fixtureSecretAccess), []);
  checks.push('opening chat/settings uses metadata only; existing Keychain profile remains system with a deferred saved-key placeholder');

  const original = await state();
  await page.getByLabel('密钥保存', { exact: true }).selectOption('local');
  await page.evaluate(() => { window.__fixtureDenySecret = true; });
  await click(page.getByRole('button', { name: '保存', exact: true })); await page.getByRole('alert').waitFor();
  assert.deepEqual(await state(), original);
  checks.push('denying one-time migration authorization retains exact original profile and credential and keeps the settings draft');
  await page.evaluate(() => { window.__fixtureDenySecret = false; });
  await click(page.getByRole('button', { name: '保存', exact: true })); await page.locator('.ai-settings').waitFor({ state: 'detached' });
  const migrated = await state();
  const oldVault = JSON.parse(original.vault), newVault = JSON.parse(migrated.vault);
  for (const [account, value] of Object.entries(oldVault)) assert.equal(newVault[account], value);
  assert.ok(Object.keys(newVault).some(key => key.startsWith('local:')));
  assert.equal(await page.evaluate(async () => (await import('/src/ai/aiSettings.ts')).loadAiSettingsDeferred().keyStorage), 'local');
  checks.push('explicit migration writes the local copy before changing the reference and preserves the original Keychain entry');

  for (const board of ['board', 'board-two', 'board']) {
    await page.goto(fixture(board)); await page.locator('.ai-root.is-mac').waitFor(); await settings();
    assert.equal(await page.getByLabel('密钥保存', { exact: true }).inputValue(), 'local');
    assert.deepEqual(await page.evaluate(() => window.__fixtureSecretAccess), []);
    await click(page.getByRole('button', { name: '取消', exact: true }));
  }
  checks.push('recreating AI windows and switching boards never reads any credential and retains prompt-free storage');
  await settings(); await click(page.getByRole('button', { name: '测试连接', exact: true })); await page.getByText(/所选合成模型已响应/).waitFor();
  assert.ok((await page.evaluate(() => window.__fixtureSecretAccess)).every(access => access.storage === 'local'));
  await shot('credentials-01-prompt-free-settings');
  await click(page.getByRole('button', { name: '取消', exact: true }));
  const beforeSend = await state(); await page.evaluate(() => { window.__fixtureDenySecret = true; });
  await page.getByLabel('输入问题', { exact: true }).fill('这是一条合成测试问题');
  await click(page.getByRole('button', { name: '发送', exact: true })); await page.getByText(/原连接和密钥已保留/).waitFor();
  assert.equal(await page.getByLabel('输入问题', { exact: true }).inputValue(), '这是一条合成测试问题');
  assert.equal(await page.evaluate(() => window.__fixtureCatalogRequests.length), 0); assert.deepEqual(await state(), beforeSend);
  await page.evaluate(() => { window.__fixtureDenySecret = false; });
  await click(page.getByRole('button', { name: '发送', exact: true })); await page.getByText('合成凭据验收通过，未调用真实模型。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__fixtureCatalogRequests.length), 1);
  await shot('credentials-02-chat-retry');
  checks.push('connection test and first send resolve only the local backend; read failure preserves the question/configuration and explicit retry succeeds');

  await page.evaluate(async () => { const { saveAiProfile, DEFAULT_AI_SETTINGS } = await import('/src/ai/aiSettings.ts'); await saveAiProfile({ ...DEFAULT_AI_SETTINGS, keyStorage: 'system', apiKey: 'qa-other-key', shareBoard: false }, '另一钥匙串配置'); });
  await page.reload(); await page.locator('.ai-root.is-mac').waitFor(); await settings();
  await page.getByLabel('密钥保存', { exact: true }).selectOption('local'); await page.getByLabel('API Key', { exact: true }).fill('qa-reentered');
  await page.evaluate(() => { window.__fixtureDenySecret = true; });
  await click(page.getByRole('button', { name: '保存', exact: true })); await page.locator('.ai-settings').waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.__fixtureSecretAccess), []);
  checks.push('manually re-entering a key switches to local storage without querying Keychain at all');
  await settings(); await page.getByLabel('API 地址', { exact: true }).fill('https://changed.invalid/v1');
  assert.equal(await page.getByLabel('API Key', { exact: true }).getAttribute('placeholder'), '仅保存在本机');
  assert.equal(await page.getByRole('button', { name: '测试连接', exact: true }).isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.__fixtureSecretAccess), []);
  await page.setViewportSize({ width: 380, height: 600 }); await shot('credentials-03-narrow-settings');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  checks.push('changing endpoint clears the saved-key reference and prevents silent credential reuse; narrow layout has no horizontal overflow');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'credentials-qa.json'), JSON.stringify({ engine, checks, pageErrors: errors, realProviderCalls: 0, realCredentialsRead: 0, limitation: 'Synthetic bridge; OS prompt/ACL verified separately on the user Mac' }, null, 2));
  await browser.close(); console.log(JSON.stringify({ pass: true, checks: checks.length, output }));
})().catch(async error => { if (page) await shot('credentials-failure').catch(() => {}); if (browser) await browser.close(); console.error(error); process.exitCode = 1; });
