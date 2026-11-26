// Exercise the real canvas UI against the isolated WebKit storage fixture.
const { webkit } = require(process.env.LSQ_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.LSQ_UI_URL || 'http://127.0.0.1:5198';
const out = process.env.LSQ_UI_EVIDENCE || 'heat-labels-evidence';
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = `${base}/scripts/knowledge-ui-fixture.html?mode=main&platform=macos&captureQA`;
  const saved = () => page.getByRole('button', { name: '已保存', exact: true }).waitFor();
  const board = () => page.evaluate(() => JSON.parse(localStorage.getItem('lumen.fixture-capture')).boards.board);
  const live = page.locator('.board-canvas-live');
  const marker = id => live.locator(`[data-heat-node="${id}"]`);
  const menu = page.getByRole('menuitem', { name: '热力名称…' });
  const editor = page.getByRole('dialog', { name: '热力名称' });
  const savedButton = editor.getByRole('button', { name: '保存', exact: true });
  const open = async () => {
    await page.waitForFunction(() => window.__fixtureReactMounted);
    await page.getByText('桌面夹', { exact: true }).dblclick();
    await page.getByText('热力测试白板', { exact: true }).click();
    await live.waitFor();
  };
  const seed = async (nodes, zoom, edges = [], translation = { x: 95, y: 105 }, documents = {}) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__fixtureReactMounted);
    await page.evaluate(({ nodes, zoom, edges, translation, documents }) => {
      const time = new Date().toISOString();
      const graph = { version: 1, id: 'board', projectId: 'project', name: '热力测试白板',
        edges: edges.map(edge => ({ directed: true, created_at: time, ...edge })),
        viewport: { ...translation, zoom }, created_at: time, updated_at: time,
        nodes: nodes.map(node => ({ x: 500, y: 410, w: 260, h: 96, docs: [], created_at: time, updated_at: time, ...node })) };
      localStorage.setItem('lumen.fixture-capture', JSON.stringify({ documents, boards: { board: graph }, chats: null }));
      localStorage.removeItem('lumen.fixture-navigation');
    }, { nodes, zoom, edges, translation, documents });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await open();
  };
  const edit = async (target, node, name, color, fontSize) => {
    await target.click({ button: 'right' });
    await menu.click();
    if (node) await editor.getByLabel('节点').selectOption(node);
    await editor.getByRole('textbox', { name: '名称', exact: true }).fill(name);
    await editor.locator('input[type=color]').fill(color);
    const slider = editor.getByLabel('字号', { exact: true });
    await slider.focus();
    await slider.press('Home');
    for (let step = 12; step < fontSize; step++) await slider.press('ArrowRight');
    assert.equal(await editor.locator('.heat-label-text').evaluate(el => getComputedStyle(el).fontSize), `${fontSize}px`);
    await savedButton.click();
    await editor.waitFor({ state: 'hidden' });
    await saved();
  };
  const watchCamera = () => page.evaluate(() => {
    const started = performance.now();
    window.__heatCamera = [];
    const record = () => {
      const world = document.querySelector('.board-canvas-live > .canvas-world');
      if (world) {
        const matrix = new DOMMatrix(world.style.transform);
        window.__heatCamera.push({ x: matrix.e, y: matrix.f, zoom: matrix.a });
      }
      if (performance.now() - started < 800) requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
  });
  const wheel = deltaY => live.evaluate((el, value) => {
    const box = el.getBoundingClientRect();
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: value,
      clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
  }, deltaY);

  try {
    await seed([{ id: 'first', title: '推导', color: '#d15658' }, { id: 'simple', title: '普通节点', x: 730 },
      { id: 'second', title: '论文', x: 1180, y: 420, color: '#d15658' }], .28);
    await edit(live.locator('.heat-cell[data-count="2"]'), 'first', '核心推导', '#d43c63', 23);
    await edit(live.locator('.heat-cell[data-count="1"]'), null, '论文结构', '#167bb1', 19);
    assert.deepEqual((await board()).nodes.map(node => node.heatLabel), [
      { name: '核心推导', color: '#d43c63', fontSize: 23 }, undefined, { name: '论文结构', color: '#167bb1', fontSize: 19 },
    ]);
    await marker('first').waitFor();
    assert.equal(await marker('first').locator('span').evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)');
    await page.screenshot({ path: `${out}/heat-01-names.png` });

    await wheel(Math.log(2) / .0015);
    const summary = live.getByRole('button', { name: '2 个重要节点', exact: true });
    await summary.waitFor();
    assert.equal(await live.locator('.heat-cell[data-count="3"] .heat-cell-count').textContent(), '3');
    await summary.hover();
    const list = page.getByRole('dialog', { name: '重要节点' });
    const second = list.getByRole('button', { name: '论文结构', exact: true });
    await second.waitFor();
    assert.deepEqual(await list.getByRole('button').allTextContents(), ['核心推导', '论文结构']);
    const bounds = await list.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 1000 && bounds.y + bounds.height <= 720);
    await second.hover();
    await page.waitForTimeout(250);
    assert.equal(await list.isVisible(), true);
    await page.screenshot({ path: `${out}/heat-02-list.png` });
    await saved();

    await watchCamera();
    await second.click();
    await marker('second').waitFor();
    await saved();
    const after = await board();
    assert.ok(after.viewport.zoom > .14 && after.viewport.zoom < .35);
    const frames = await page.evaluate(() => window.__heatCamera);
    const moving = frames.filter(frame => frame.zoom > .145 && frame.zoom < .315);
    assert.ok(moving.length >= 4 && moving.some(frame => Math.abs(frame.x - moving[0].x) > 3), JSON.stringify(frames));
    const at = await marker('second').boundingBox(), canvas = await live.boundingBox();
    assert.ok(Math.abs(at.x + at.width / 2 - (canvas.x + canvas.width / 2)) < 2);
    assert.ok(Math.abs(at.y + at.height / 2 - (canvas.y + canvas.height / 2)) < 2);
    assert.equal(await list.count(), 0);

    await page.evaluate(() => localStorage.removeItem('lumen.fixture-navigation'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await open();
    await marker('second').click({ button: 'right' });
    await menu.click();
    await editor.getByRole('button', { name: '移除名称' }).click();
    await saved();
    assert.equal((await board()).nodes.find(node => node.id === 'second').heatLabel, undefined);
    await live.getByRole('button', { name: '撤销', exact: true }).click();
    await saved();
    assert.equal((await board()).nodes.find(node => node.id === 'second').heatLabel?.name, '论文结构');

    await live.locator('.canvas-zoom-label').click();
    await page.waitForFunction(() => parseInt(document.querySelector('.canvas-zoom-label').textContent) > 38);
    await wheel(470);
    await saved();
    const interrupted = await board();
    assert.ok(interrupted.viewport.zoom < .78);
    await page.waitForTimeout(550);
    assert.ok(Math.abs(Number.parseFloat(await live.locator('.canvas-zoom-label').textContent()) - interrupted.viewport.zoom * 100) < 1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const immediate = await live.locator('.canvas-zoom-label').evaluate(el => new Promise(resolve => {
      el.click(); requestAnimationFrame(() => resolve(el.textContent));
    }));
    assert.equal(immediate, '100%');

    await seed([{ id: 'a', title: '甲', heatLabel: { name: '重合的甲', color: '#167bb1', fontSize: 19 } },
      { id: 'b', title: '乙', heatLabel: { name: '重合的乙', color: '#d43c63', fontSize: 19 } }], .28);
    const cluster = live.getByRole('button', { name: '2 个重要节点', exact: true });
    await cluster.focus();
    await cluster.press('Enter');
    await list.getByRole('button', { name: '重合的乙' }).click();
    await live.locator('.heat-label-destination').getByText('重合的乙').waitFor();
    assert.ok(await live.locator('[data-node-id="b"].is-selected').count());

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const nodes = [], edges = [], zoom = .17, camera = { x: 90, y: 50 };
    // Each row crosses several of the old 48px screen buckets during a short pan.
    for (const [i, x] of [220, 250, 412, 442, 600, 630, 220, 250, 412, 442, 600, 630].entries()) {
      const y = i < 6 ? 325 : 460;
      for (const [end, offset] of [['a', -70], ['b', 70]]) {
        nodes.push({ id: `${end}${i}`, title: `${end}${i}`, w: 240,
          x: (x - camera.x) / zoom - 120, y: (y + offset - camera.y) / zoom - 48 });
      }
      edges.push({ id: `edge-${i}`, from: `a${i}`, to: `b${i}`, label: `样例连线 ${i}` });
    }
    await seed(nodes, zoom, edges, camera);
    const hints = live.locator('.edge-label-hint');
    await hints.first().waitFor();
    const original = await live.evaluateHandle(el => [...el.querySelectorAll('.edge-label-hint')].map(node => ({ node, rect: node.getBoundingClientRect() })));
    assert.equal(await hints.count(), 12);
    await page.mouse.move(805, 175);
    await page.mouse.down();
    for (const [dx, dy] of [[8, 9], [24, 18], [32, 26], [48, 39], [64, 48], [80, 61], [24, 18], [0, 0]]) {
      await page.mouse.move(805 + dx, 175 + dy, { steps: 4 });
      await page.waitForFunction(({ x, y }) => {
        const matrix = new DOMMatrix(document.querySelector('.board-canvas-live .canvas-world').style.transform);
        return matrix.e === x && matrix.f === y;
      }, { x: camera.x + dx, y: camera.y + dy });
      assert.equal(await hints.count(), 12);
      assert.ok(await original.evaluate((items, { dx, dy }) => items.every(({ node, rect }) => {
        const moved = node.getBoundingClientRect();
        return node.isConnected && Math.abs(moved.x - rect.x - dx) < .2 && Math.abs(moved.y - rect.y - dy) < .2;
      }), { dx, dy }));
    }
    await page.mouse.up();
    await original.dispose();
    await page.screenshot({ path: `${out}/heat-03-stable-edge-hints.png` });
    assert.equal(await live.locator('.canvas-zoom-label').textContent(), '17%');

    const docs = {}, detailed = [];
    for (let index = 0; index < 12; index++) {
      const path = `docs/overview-${index}.md`;
      docs[path] = '# 合成公式笔记\n\n' + Array.from({ length: 14 }, (_, n) => `第 ${n + 1} 段预览内容，示例公式 $x_${n} = ${index}$.\n\n`).join('');
      detailed.push({ id: `doc-${index}`, title: `预览 ${index}`, x: 110 + index % 4 * 370, y: 110 + Math.floor(index / 4) * 375,
        docs: [{ path, title: `公式笔记 ${index}` }] });
    }
    await seed(detailed, .365, [], { x: 25, y: 70 }, docs);
    const readyPreviews = '.node-preview:not([hidden]) .node-page-viewport[data-content-status="ready"]';
    const preview = live.locator('[data-node-id="doc-0"] .node-preview');
    await page.waitForFunction(selector => document.querySelectorAll(selector).length === 12, readyPreviews);
    await preview.hover();
    await preview.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await preview.getAttribute('data-preview-page'), '1');
    await page.evaluate(() => {
      window.originalPreview = document.querySelector('[data-node-id="doc-0"] .node-page-columns');
      window.previewReads = 0;
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (command === 'document_payload') window.previewReads++;
        return invoke(command, args);
      };
    });
    await wheel(138);
    await live.locator('.heat-layer[data-level="1"]').waitFor();
    assert.equal(await preview.isVisible(), false);
    assert.equal(await page.evaluate(() => window.originalPreview.isConnected), true);
    await wheel(-138);
    await page.waitForFunction(selector => document.querySelectorAll(selector).length === 12, readyPreviews);
    assert.equal(await preview.getAttribute('data-preview-page'), '1');
    assert.ok(await page.evaluate(() => window.previewReads === 0 && window.originalPreview === document.querySelector('[data-node-id="doc-0"] .node-page-columns')));

    await wheel(600);
    await live.locator('.heat-layer[data-level="2"]').waitFor();
    assert.equal(await page.evaluate(() => window.originalPreview.isConnected), false);
    await wheel(-600);
    await page.waitForFunction(selector => document.querySelectorAll(selector).length === 12, readyPreviews);
    assert.equal(await preview.getAttribute('data-preview-page'), '1');
    assert.equal(await page.evaluate(() => window.previewReads), 12);
    assert.deepEqual(errors, []);
    console.log('Heat label editing, smooth camera movement, stable edge hints and live preview reuse at the overview boundary passed.');
  } catch (error) {
    await page.screenshot({ path: `${out}/heat-failure.png` });
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
