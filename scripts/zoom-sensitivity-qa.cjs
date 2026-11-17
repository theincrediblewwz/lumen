// Actual App, synthetic storage and images; no Provider or user library access.
// Browser plugin not available; use the project's Playwright/WebKit runtime.
const { webkit } = require(process.env.LSQ_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.LSQ_UI_URL || 'http://127.0.0.1:5198';
const out = process.env.LSQ_UI_EVIDENCE || path.resolve('mac-ui-evidence');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [], checks = [], shadows = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('lumen.fixture-capture')));
  const saved = () => page.waitForFunction(() => document.querySelector('.board-save-state')?.textContent === '已保存');
  const settingSaved = async (value, id = 'board') => {
    await page.waitForFunction(({ value, id }) => JSON.parse(localStorage.getItem('lumen.fixture-capture')).boards[id].appearance?.zoomSensitivity === value, { value, id });
    await saved();
  };
  const card = id => page.locator(`.canvas-world>[data-node-id="${id}"]`);
  const openBoard = async name => {
    const expand = page.getByRole('button', { name: '展开侧栏', exact: true });
    if (await expand.count()) await expand.click();
    if (!await page.getByText(name, { exact: true }).isVisible()) await page.getByText('桌面夹', { exact: true }).click();
    await page.getByText(name, { exact: true }).click();
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    await page.locator('.board-canvas-live').waitFor();
    // The sidebar animates its width; wait for the actual canvas origin to settle.
    // Otherwise the recorded client point and the event handler use different origins.
    await page.waitForFunction(() => document.querySelector('.sidebar.is-collapsed')?.getBoundingClientRect().width === 0);
  };
  const wheel = async (deltaY, boardId = 'board') => {
    const before = (await state()).boards[boardId].viewport;
    const rect = await page.locator('.board-canvas-live').boundingBox();
    const point = { x: 30, y: 40 };
    await page.locator('.board-canvas-live').dispatchEvent('wheel', {
      deltaY, ctrlKey: true, clientX: rect.x + point.x, clientY: rect.y + point.y,
    });
    await page.waitForFunction(({ id, zoom }) => JSON.parse(localStorage.getItem('lumen.fixture-capture')).boards[id].viewport.zoom !== zoom, { id: boardId, zoom: before.zoom });
    await saved();
    const after = (await state()).boards[boardId].viewport;
    for (const axis of ['x', 'y']) {
      assert.ok(Math.abs((point[axis] - before[axis]) / before.zoom - (point[axis] - after[axis]) / after.zoom) < 1e-6, JSON.stringify({ before, after, point, rect, axis }));
    }
    return Math.log(after.zoom / before.zoom);
  };
  try {
    await page.goto(base + '/scripts/knowledge-ui-fixture.html?mode=main&platform=macos&captureQA', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__fixtureReactMounted);
    assert.match(await page.title(), /知识库合成页面验收/);
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    await page.evaluate(async () => {
      const image = document.createElement('canvas'); image.width = 600; image.height = 260;
      const c = image.getContext('2d'); c.fillStyle = 'white'; c.fillRect(0, 0, 600, 260);
      c.fillStyle = '#202322'; c.font = 'bold 28px serif'; c.fillText('THEOREM 5.2', 25, 50);
      c.font = '24px serif'; c.fillText('x + 1 = 2', 100, 130); c.fillText('Synthetic image', 25, 230);
      const doc = await window.__TAURI_INTERNALS__.invoke('image_document', {
        projectId: 'project', boardId: 'board', expectedScope: 'synthetic-scope', base64Data: image.toDataURL().split(',')[1],
      });
      const s = JSON.parse(localStorage.getItem('lumen.fixture-capture'));
      const at = '2026-11-18', node = (id, title, x, extra = {}) => ({ id, title, x, y: 210, w: 360, h: 156, docs: [], created_at: at, updated_at: at, ...extra });
      s.boards.board = { version: 1, id: 'board', projectId: 'project', name: '阴影与灵敏度', created_at: at, updated_at: at,
        viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('plain', '文字节点 \\nu', 80), node('pure', '', 530, { docs: [doc], sticker: true, imageAspect: 600 / 260 }), node('mixed', '图文节点', 980, { docs: [doc] })], edges: [] };
      s.boards.second = { ...s.boards.board, id: 'second', name: '另一块白板', nodes: [node('other', '独立设置', 80)] };
      localStorage.setItem('lumen.fixture-capture', JSON.stringify(s));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__fixtureReactMounted);
    await openBoard('阴影与灵敏度');
    await page.waitForFunction(() => document.querySelectorAll('.sticker-image').length === 2 && [...document.querySelectorAll('.sticker-image')].every(e => e.naturalWidth === 600));
    for (const theme of ['light', 'dark', 'paper']) {
      await page.evaluate(async theme => { const m = await import('/src/settings.ts'); m.applySettings({ ...m.DEFAULT_SETTINGS, theme, glass: false }, 'macos'); }, theme);
      for (const zoom of [1, .5]) {
        const current = (await state()).boards.board.viewport.zoom;
        if (Math.abs(current - zoom) > .001) await wheel(Math.log(current / zoom) / .0015);
        await page.mouse.move(1400, 70); await page.waitForTimeout(240);
        const styles = await page.evaluate(() => {
          const read = id => {
            const el = document.querySelector(`[data-node-id="${id}"]`), s = getComputedStyle(el), glow = getComputedStyle(el, '::before');
            return { shadow: s.boxShadow, glow: glow.boxShadow, opacity: glow.opacity, display: glow.display, content: glow.content, border: s.borderTopWidth, background: s.backgroundColor };
          }; return { plain: read('plain'), pure: read('pure'), mixed: read('mixed') };
        });
        assert.equal(styles.pure.shadow, styles.plain.shadow);
        assert.equal(styles.pure.glow, styles.plain.glow); assert.equal(styles.pure.opacity, styles.plain.opacity);
        assert.notEqual(styles.pure.display, 'none'); assert.notEqual(styles.pure.content, 'none');
        assert.equal(styles.mixed.shadow, styles.plain.shadow); assert.equal(styles.pure.border, '0px');
        assert.equal(styles.pure.background, 'rgba(0, 0, 0, 0)');
        if (zoom === .5) assert.ok(Number(styles.pure.opacity) > .4);
        shadows.push({ theme, zoom, styles });
        checks.push(`${theme} ${zoom * 100}%: image and text share shadow and zoom glow; pure image retains no frame`);
        await page.screenshot({ path: path.join(out, `zoom-shadow-${theme}-${zoom * 100}.png`) });
      }
    }
    await card('pure').hover(); await page.waitForTimeout(200);
    const pureHover = await card('pure').evaluate(e => getComputedStyle(e).boxShadow);
    await card('plain').hover(); await page.waitForTimeout(200);
    assert.equal(pureHover, await card('plain').evaluate(e => getComputedStyle(e).boxShadow));
    checks.push('hover shadow matches ordinary nodes');
    await page.mouse.move(1400, 70);
    await page.locator('.board-settings-fab').click();
    const slider = page.getByRole('slider', { name: '双指缩放灵敏度', exact: true });
    assert.equal(await slider.inputValue(), '1');
    await slider.focus(); await slider.press('Home'); assert.equal(await slider.inputValue(), '0.25');
    await settingSaved(.25); assert.equal((await state()).boards.board.appearance.zoomSensitivity, .25);
    await page.getByRole('button', { name: '关闭白板设置', exact: true }).click();
    const slow = await wheel(-80);
    await page.locator('.board-settings-fab').click(); await slider.focus(); await slider.press('End');
    assert.equal(await slider.inputValue(), '3'); await settingSaved(3);
    await page.getByRole('button', { name: '关闭白板设置', exact: true }).click();
    const fast = await wheel(-80); assert.ok(Math.abs(fast / slow - 12) < .001);
    checks.push('slider keyboard endpoints save; same pinch delta responds 12 times more strongly at 3x than 0.25x, anchored to pointer');
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.__fixtureReactMounted);
    await openBoard('阴影与灵敏度'); await page.locator('.board-settings-fab').click();
    assert.equal(await slider.inputValue(), '3'); checks.push('sensitivity persists across reload');
    await page.setViewportSize({ width: 720, height: 480 });
    const panel = page.getByRole('dialog', { name: '白板设置', exact: true });
    const bounds = await panel.boundingBox(); assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 480);
    await slider.scrollIntoViewIfNeeded(); await slider.focus(); await slider.press('ArrowLeft');
    assert.equal(await slider.inputValue(), '2.95'); await settingSaved(2.95);
    await page.screenshot({ path: path.join(out, 'zoom-settings-720.png') });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.screenshot({ path: path.join(out, 'zoom-settings-1440.png') });
    checks.push('720x480 settings remain inside canvas and scroll to functional slider');
    await page.getByRole('button', { name: '关闭白板设置', exact: true }).click();
    await openBoard('另一块白板'); await page.locator('.board-settings-fab').click();
    assert.equal(await slider.inputValue(), '1'); await slider.focus(); await slider.press('Home');
    for (let i = 0; i < 5; i++) await slider.press('ArrowRight');
    assert.equal(await slider.inputValue(), '0.5'); await settingSaved(.5, 'second');
    assert.equal((await state()).boards.board.appearance.zoomSensitivity, 2.95);
    assert.equal((await state()).boards.second.appearance.zoomSensitivity, .5);
    await page.getByRole('button', { name: '关闭白板设置', exact: true }).click();
    await openBoard('阴影与灵敏度'); await page.locator('.board-settings-fab').click();
    assert.equal(await slider.inputValue(), '2.95'); checks.push('boards keep separate saved sensitivities; old board defaults to 1x');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'zoom-sensitivity-report.json'), JSON.stringify({ browser: 'WebKit', fallback: 'Browser plugin not available', pageIdentity: true, notBlank: true, noOverlay: true, checks, errors, shadows, slow, fast }, null, 2));
    console.log(JSON.stringify({ checks: checks.length, errors, slow, fast }));
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'zoom-sensitivity-failure.png') });
    fs.writeFileSync(path.join(out, 'zoom-sensitivity-failure.txt'), error.stack + '\n' + JSON.stringify(errors));
    throw error;
  } finally { await browser.close(); }
})();
