// Exercise the real desktop application with an isolated, synthetic storage bridge.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webkit } = require(process.env.LSQ_PLAYWRIGHT_MODULE || 'playwright');
const address = (process.env.LSQ_UI_URL || 'http://127.0.0.1:5198') + '/scripts/knowledge-ui-fixture.html?mode=main&platform=macos';
const evidence = path.resolve(process.env.LSQ_UI_EVIDENCE || 'mac-ui-evidence');

(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  const browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
  const checks = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const check = label => { checks.push(label); console.log(label); };
  const folder = name => page.locator('.project-tile.is-project').getByRole('button', { name, exact: true });
  const board = name => page.locator('.project-tile.is-board').getByRole('button', { name, exact: true });
  const port = (name, kind = '项目') => page.getByRole('button', { name: `从${name}拉出${kind}连线`, exact: true });
  const arrow = (from, to) => page.getByRole('button', { name: `${from} → ${to}`, exact: true });
  // A horizontal or vertical SVG path has zero height or width before its stroke is applied.
  const waitArrow = line => line.waitFor({ state: 'attached' });
  const crumb = name => page.getByRole('navigation', { name: '项目路径' }).getByRole('button', { name, exact: true });
  const canvas = () => page.locator('.project-canvas');
  const trail = () => page.locator('.project-path [aria-current=page]').innerText();
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('lumen.fixture-navigation')));
  const menuItem = name => page.getByRole('menuitem', { name, exact: true });
  const branches = owner => page.locator(`.project-tile[data-preview-owner="${owner}"]`);
  const allBranches = () => page.locator('.project-tile.is-preview-tile');
  const settled = owner => page.waitForFunction(id => {
    const cards = [...document.querySelectorAll(`.project-tile[data-preview-owner="${id}"]`)];
    return cards.length > 0 && cards.every(card => card.style.opacity === '1');
  }, owner);
  const positions = () => page.locator('.project-tile:not(.is-preview-tile)').evaluateAll(cards => Object.fromEntries(cards.map(card => {
    const point = new DOMMatrixReadOnly(card.style.transform);
    return [card.querySelector('.project-tile-open').dataset.id, [point.m41, point.m42]];
  })));
  const watchPreview = (endpoint = null) => page.evaluate(id => new Promise(resolve => {
    const frames = [], end = performance.now() + 770;
    function read(now) {
      const tile = document.querySelector(id ? `[data-preview-endpoint="${id}"]` : '.project-tile.is-preview-tile.is-board');
      const line = tile && document.querySelector(`.project-preview-spoke[data-preview-child="${tile.dataset.previewEndpoint}"]`);
      if (tile && line) {
        const point = new DOMMatrixReadOnly(tile.style.transform);
        const from = ['x1', 'y1'].map(key => Number(line.getAttribute(key)));
        const to = ['x2', 'y2'].map(key => Number(line.getAttribute(key)));
        const dx = Math.abs(to[0] - (point.m41 + 77)), dy = Math.abs(to[1] - (point.m42 + 45));
        frames.push({
          clock: now, alpha: Number(tile.style.opacity), to,
          length: Math.hypot(to[0] - from[0], to[1] - from[1]),
          endpointError: Math.abs(Math.max(dx / 65, dy / 37) - 1),
        });
      }
      if (now < end) requestAnimationFrame(read); else resolve(frames);
    }
    requestAnimationFrame(read);
  }), endpoint);
  const watchNavigation = () => page.evaluate(() => new Promise(resolve => {
    const frames = [];
    const end = performance.now() + 720;
    function read(now) {
      const host = document.querySelector('.workspace'), phase = host?.dataset.canvasNavigation;
      const canvas = host?.firstElementChild;
      if (phase && canvas) frames.push({ phase, opacity: Number(getComputedStyle(canvas).opacity) });
      if (now < end) requestAnimationFrame(read); else resolve(frames);
    }
    requestAnimationFrame(read);
  }));
  const assertTransition = frames => {
    for (const phase of ['leaving', 'entering']) {
      const samples = frames.filter(frame => frame.phase === phase && frame.opacity > 0 && frame.opacity < 1);
      assert.ok(new Set(samples.map(sample => sample.opacity)).size >= 3, JSON.stringify(frames));
    }
  };
  const point = async (locator, offsetY = 32) => {
    const rect = await locator.boundingBox();
    assert.ok(rect);
    return { x: rect.x + rect.width / 2, y: rect.y + (offsetY ?? rect.height / 2) };
  };
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up();
  };
  const onPath = (line, fraction = 0.5) => line.evaluate((el, ratio) => {
    const p = el.getPointAtLength(el.getTotalLength() * ratio).matrixTransform(el.getScreenCTM());
    return { x: p.x, y: p.y };
  }, fraction);
  const straightPath = /^M [-\d.e+]+ [-\d.e+]+ L [-\d.e+]+ [-\d.e+]+$/i;
  const checkNameDialog = async (dialog, screenshot) => {
    await dialog.waitFor();
    const { background, insets } = await dialog.evaluate(form => {
      const box = form.getBoundingClientRect();
      const insets = [...form.querySelectorAll('h2, input, button')].map(element => {
        const child = element.getBoundingClientRect();
        return Math.min(child.left - box.left, box.right - child.right,
          child.top - box.top, box.bottom - child.bottom);
      });
      return { background: getComputedStyle(form).backgroundColor, insets };
    });
    assert.ok(background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)');
    assert.equal(insets.length, 4);
    assert.ok(insets.every(inset => inset >= 16), `Naming dialog insets: ${insets}`);
    if (screenshot) await dialog.screenshot({ path: path.join(evidence, screenshot), animations: 'disabled' });
  };
  const newItem = async (kind, title, root = false) => {
    await page.getByRole('button', { name: root ? '新建项目' : '新建', exact: true }).click();
    if (!root) await menuItem(kind === 'project' ? '新建项目' : '新建白板').click();
    const dialog = page.getByRole('dialog', { name: kind === 'project' ? '新建项目' : '新建白板', exact: true });
    await checkNameDialog(dialog, root ? 'project-name-create.png' : undefined);
    const input = dialog.getByRole('textbox', { name: '名称', exact: true });
    await input.fill(title); await input.press('Enter');
    await (kind === 'project' ? folder(title) : board(title)).waitFor();
  };
  try {
    await page.goto(address + '&projectCanvasQA&nodes', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await canvas().waitFor();
    assert.equal(await trail(), '项目首页');
    assert.equal(await page.locator('.project-tile.is-project').count(), 2);
    assert.equal(await page.locator('.project-tile.is-board, .sidebar').count(), 0);
    await page.getByRole('button', { name: '菜单', exact: true }).click();
    await menuItem('导入').waitFor();
    assert.equal(await menuItem('新建').count(), 0);
    await page.keyboard.press('Escape');
    await canvas().click({ button: 'right', position: { x: 800, y: 250 } });
    await menuItem('新建项目').waitFor();
    assert.equal(await menuItem('新建白板').count(), 0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('.settings-card').waitFor(); await page.keyboard.press('Escape');
    check('legacy projects appear on the root canvas; creation stays in the canvas and the top menu keeps import and export');

    await newItem('project', '第三个项目', true);
    const start = await point(folder('第三个项目'));
    await drag(start, { x: start.x + 160, y: start.y + 260 });
    const rootFolder = (await saved()).projects.find(project => project.name === '第三个项目');
    const rootPosition = (await saved()).layout.projects[rootFolder.id].position;
    assert.ok(rootPosition.x > 500 && rootPosition.y > 300);
    assert.equal(await trail(), '项目首页');
    check('dragging a project persists its position without opening it');

    const originals = await positions(), layoutBefore = (await saved()).layout;
    const originalView = await page.locator('.project-canvas-world').getAttribute('style');
    const expansion = watchPreview();
    await folder('桌面夹').click();
    await settled('project');
    const openingFrames = await expansion;
    assert.equal(await trail(), '项目首页');
    assert.equal(await folder('桌面夹').getAttribute('aria-expanded'), 'true');
    assert.equal(await branches('project').count(), 2);
    const spread = await positions();
    assert.notDeepEqual(spread['project-other'], originals['project-other']);
    assert.deepEqual(spread.project, originals.project);
    for (const axis of [0, 1]) {
      const oldDistance = originals[rootFolder.id][axis] - originals['project-other'][axis];
      const newDistance = spread[rootFolder.id][axis] - spread['project-other'][axis];
      assert.ok(Math.abs(newDistance - oldDistance) < 0.01);
    }
    assert.ok(openingFrames.filter(frame => frame.alpha > 0.02 && frame.alpha < 0.98).length >= 3);
    assert.ok(openingFrames.every(frame => frame.endpointError < 0.02));
    assert.ok(openingFrames.every((frame, i) => i === 0 || frame.length >= openingFrames[i-1].length - 0.01));
    await page.screenshot({ path: path.join(evidence, 'project-folder-preview-expanded.png') });
    const collapse = watchPreview();
    await folder('桌面夹').click();
    await allBranches().first().waitFor({ state: 'detached' });
    const closingFrames = await collapse;
    assert.ok(closingFrames.filter(frame => frame.alpha > 0.02 && frame.alpha < 0.98).length >= 3);
    assert.ok(closingFrames.every(frame => frame.endpointError < 0.02));
    assert.ok(closingFrames.every((frame, i) => i === 0 || frame.length <= closingFrames[i-1].length + 0.01));
    assert.deepEqual(await positions(), originals);
    assert.equal(await page.locator('.project-canvas-world').getAttribute('style'), originalView);
    assert.deepEqual((await saved()).layout, layoutBefore);
    fs.writeFileSync(path.join(evidence, 'project-folder-preview-frames.json'), JSON.stringify({ openingFrames, closingFrames }, null, 2));
    check('single-click animates the same card and spoke positions on every frame; other folders keep their spacing and collapse restores the layout');

    await folder('桌面夹').click();
    await settled('project');
    await folder('另一项目').click();
    await settled('project-other');
    assert.equal(await branches('project').count(), 0);
    assert.equal(await folder('桌面夹').getAttribute('aria-expanded'), 'false');
    assert.equal(await trail(), '项目首页');
    await branches('project-other').getByRole('button', { name: '另一项目的白板', exact: true }).click();
    await page.locator('.board-canvas-live').waitFor();
    assert.equal(await trail(), '另一项目的白板');
    await crumb('项目首页').click();
    await folder('桌面夹').waitFor();
    assert.deepEqual(await positions(), originals);
    assert.equal(await allBranches().count(), 0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await folder('桌面夹').press('Space');
    await branches('project').first().waitFor();
    assert.equal(await branches('project').first().evaluate(card => card.style.opacity), '1');
    await folder('桌面夹').press('Escape');
    await allBranches().first().waitFor({ state: 'detached' });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    assert.deepEqual((await saved()).layout, layoutBefore);
    check('switching previews and opening a projected board use the correct project; returning clears the temporary view, and reduced motion snaps');

    await folder('桌面夹').hover();
    const source = await point(port('桌面夹'), null);
    const target = await point(folder('另一项目'));
    await page.mouse.move(source.x, source.y); await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 12 });
    await page.locator('.project-relation-draft').waitFor();
    await page.locator('.project-tile.is-connection-target').filter({ hasText: '另一项目' }).waitFor();
    await page.mouse.up();
    const rootArrow = arrow('桌面夹', '另一项目');
    await waitArrow(rootArrow);
    assert.deepEqual((await saved()).layout.relations, [{ from: 'project', to: 'project-other' }]);
    assert.equal(await trail(), '项目首页');
    const firstPath = await rootArrow.getAttribute('d');
    assert.match(firstPath, straightPath);
    await drag(target, { x: target.x + 96, y: target.y + 155 });
    await page.waitForFunction(d => document.querySelector('.project-relation-hit')?.getAttribute('d') !== d, firstPath);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('lumen.fixture-navigation')).layout.projects['project-other']?.position?.y > 200);
    assert.equal(await rootArrow.getAttribute('d') === firstPath, false);
    const unbent = await rootArrow.getAttribute('d'), middle = await onPath(rootArrow);
    await drag(middle, { x: middle.x + 72, y: middle.y - 90 });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('lumen.fixture-navigation')).layout.relations[0]?.bend != null);
    assert.match(await rootArrow.getAttribute('d'), / Q /);
    const corner = await page.locator('.project-relation-handle').evaluate(el => {
      const p = new DOMPoint(el.cx.baseVal.value, el.cy.baseVal.value).matrixTransform(el.getScreenCTM());
      return { x: p.x, y: p.y };
    });
    await drag(corner, middle);
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem('lumen.fixture-navigation')).layout.relations[0]?.bend);
    assert.equal(await rootArrow.getAttribute('d'), unbent);
    assert.equal(await page.getByRole('textbox', { name: '项目连线名称' }).count(), 0);
    await page.mouse.move(960, 155);
    await page.screenshot({ path: path.join(evidence, 'project-canvas-relations.png'), animations: 'disabled' });
    check('folder arrows are straight by default and follow moved cards; the line can bend and snap back to straight');

    await port('另一项目').press('Enter');
    await menuItem('连到项目…').click(); await menuItem('桌面夹').click();
    const reverse = arrow('另一项目', '桌面夹');
    await waitArrow(reverse);
    assert.notEqual(await rootArrow.getAttribute('d'), await reverse.getAttribute('d'));
    await reverse.press('Shift+F10'); await menuItem('删除连线').click();
    await reverse.waitFor({ state: 'detached' });
    assert.equal(await rootArrow.count(), 1);
    check('keyboard menus can create the reverse arrow and remove just that direction');

    await folder('桌面夹').dblclick();
    await board('合成学习白板').waitFor();
    await newItem('project', '阅读资料');
    await newItem('board', '补充白板');
    await drag(await point(port('阅读资料'), null), await point(board('补充白板')));
    await waitArrow(arrow('阅读资料', '补充白板'));
    await drag(await point(port('合成学习白板', '白板'), null), await point(board('补充白板')));
    const boardArrow = arrow('合成学习白板', '补充白板');
    await waitArrow(boardArrow);
    const boardPath = await boardArrow.getAttribute('d');
    assert.match(boardPath, straightPath);
    await port('补充白板', '白板').press('Enter');
    await menuItem('连到项目…').click();
    await menuItem('阅读资料').click();
    const reverseMixed = arrow('补充白板', '阅读资料');
    await waitArrow(reverseMixed);
    await reverseMixed.press('Shift+F10');
    await menuItem('删除连线').click();
    await reverseMixed.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.project-relation').count(), 2);
    await boardArrow.press('Enter');
    const edgeName = page.getByRole('textbox', { name: '项目连线名称', exact: true });
    const mathName = '继续推导 $\\nu^2$';
    await edgeName.fill(mathName);
    await edgeName.press('Enter');
    await page.locator('.project-relation-names .katex').waitFor();
    assert.equal((await saved()).layout.relations.find(edge => edge.from === 'project/board').label, mathName);
    assert.equal(await trail(), '桌面夹');
    assert.equal(await page.locator('.project-tile.is-project').count(), 1);
    assert.equal(await page.locator('.project-tile.is-board').count(), 3);
    const originalBoard = (await saved()).boards.find(row => row.id === 'board');
    const boardStart = await point(board('合成学习白板'));
    await drag(boardStart, { x: boardStart.x + 250, y: boardStart.y + 295 });
    const boardPosition = (await saved()).layout.boards.project.board;
    assert.ok(boardPosition.x > 400 && boardPosition.y > 350);
    assert.deepEqual((await saved()).boards.find(row => row.id === 'board'), originalBoard);
    assert.notEqual(await boardArrow.getAttribute('d'), boardPath);
    const childStraight = await onPath(boardArrow, 0.72);
    await drag(childStraight, { x: childStraight.x + 104, y: childStraight.y + 50 });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('lumen.fixture-navigation')).layout.relations.find(edge => edge.from === 'project/board')?.bend != null);
    assert.match(await boardArrow.getAttribute('d'), / Q /);
    await page.screenshot({ path: path.join(evidence, 'project-canvas-board-relations.png') });
    check('folder-to-board, board-to-folder and board-to-board arrows support labels, selection, deletion and movement without editing board contents');

    await page.mouse.move(850, 450); await page.mouse.wheel(0, 200);
    await page.waitForFunction(() => Number(document.querySelector('.project-canvas')?.dataset.zoom) < 1);
    const blank = await canvas().evaluate(el => {
      const box = el.getBoundingClientRect();
      return { x: box.right - 120, y: box.bottom - 180 };
    });
    await drag(blank, { x: blank.x - 53, y: blank.y + 36 });
    const transform = await page.locator('.project-canvas-world').getAttribute('style');
    const parentPositions = await positions();
    const entering = watchNavigation();
    await folder('阅读资料').dblclick();
    assertTransition(await entering);
    await newItem('project', '第三层');
    await folder('第三层').dblclick();
    await newItem('board', '最深白板');
    await board('最深白板').click(); await page.locator('.board-canvas-live').waitFor();
    assert.equal(await trail(), '最深白板');
    assert.equal(await crumb('阅读资料').count(), 1);
    const returning = watchNavigation();
    await crumb('桌面夹').click(); await board('补充白板').waitFor();
    assertTransition(await returning);
    assert.equal(await page.locator('.project-canvas-world').getAttribute('style'), transform);
    assert.deepEqual(await positions(), parentPositions);
    assert.deepEqual((await saved()).layout.boards.project.board, boardPosition);
    check('project entry and breadcrumb return fade out and in over multiple frames; returning restores the pan, zoom, and tile layout exactly');

    await crumb('项目首页').click();
    await folder('桌面夹').click();
    await settled('project');
    assert.equal(await branches('project').locator('.project-preview-open').count(), 4);
    const projection = page.locator('.project-preview-arrow[data-from="project/board"]');
    await projection.waitFor();
    assert.match(await projection.getAttribute('d'), / Q /);
    assert.match(await projection.getAttribute('marker-end'), /^url\(#.+\)$/);
    await page.locator('[data-preview-label="project"] .katex').waitFor();
    assert.equal(await page.locator('.project-preview-arrow[data-preview-owner="project"]').count(), 2);
    await page.screenshot({ path: path.join(evidence, 'project-preview-labelled-arrows.png') });

    const beforeNested = await saved();
    const readingId = beforeNested.projects.find(project => project.name === '阅读资料').id;
    const deepest = beforeNested.projects.find(project => project.name === '第三层');
    const deepBoard = beforeNested.boards.find(board => board.name === '最深白板');
    const deepEndpoint = `${deepest.id}/${deepBoard.id}`;
    const reading = branches('project').getByRole('button', { name: '阅读资料', exact: true });
    const deep = branches(readingId).getByRole('button', { name: '第三层', exact: true });
    const deepPreview = branches(deepest.id).getByRole('button', { name: '最深白板', exact: true });
    const outerPositions = await positions();
    await reading.click(); await settled(readingId);
    assert.equal(await reading.getAttribute('aria-expanded'), 'true');
    assert.equal(await deepPreview.count(), 0);
    const beforeDeepView = await page.locator('.project-canvas-world').getAttribute('style');
    const deepOpening = watchPreview(deepEndpoint);
    await deep.click(); await settled(deepest.id);
    await deepPreview.waitFor();
    assert.equal(await trail(), '项目首页');
    assert.equal(await folder('桌面夹').getAttribute('aria-expanded'), 'true');
    assert.equal(await deep.getAttribute('aria-expanded'), 'true');
    assert.equal(await branches('project').count(), 4);
    assert.deepEqual(await positions(), outerPositions);
    assert.equal(await page.locator('[data-preview-label="project"] .katex').count(), 1);
    const deepLine = page.locator(`.project-preview-spoke[data-preview-child="${deepEndpoint}"]`);
    const attachedToParent = await deepLine.evaluate((element, parent) => {
      const card = document.querySelector(`[data-preview-endpoint="${parent}"]`);
      const point = new DOMMatrixReadOnly(card.style.transform);
      const x = Number(element.getAttribute('x1')) - point.m41;
      const y = Number(element.getAttribute('y1')) - point.m42;
      return x >= 22.99 && x <= 131.01 && y >= 13.99 && y <= 80.01;
    }, deepest.id);
    assert.equal(attachedToParent, true);
    const nestedFrames = await deepOpening;
    assert.ok(nestedFrames.filter(frame => frame.alpha > 0.02 && frame.alpha < 0.98).length >= 3);
    assert.ok(nestedFrames.every(frame => frame.endpointError < 0.02));
    await page.screenshot({ path: path.join(evidence, 'project-preview-nested.png') });
    await deep.click(); await branches(deepest.id).first().waitFor({ state: 'detached' });
    assert.equal(await deep.getAttribute('aria-expanded'), 'false');
    assert.equal(await reading.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.project-canvas-world').getAttribute('style'), beforeDeepView);
    assert.deepEqual(await saved(), beforeNested);
    await deep.press('Space'); await settled(deepest.id);
    await deepPreview.click(); await page.locator('.board-canvas-live').waitFor();
    assert.equal(await trail(), '最深白板');
    await crumb('项目首页').click(); await folder('桌面夹').waitFor();
    assert.equal(await allBranches().count(), 0);
    check('nested folders expand on the same canvas, animate their own spokes, and collapse a level without changing positions or saved content');

    await folder('桌面夹').click(); await settled('project');
    await reading.click(); await settled(readingId);
    await reading.dblclick();
    await folder('第三层').waitFor();
    assert.equal(await trail(), '阅读资料');
    await crumb('项目首页').click();
    await folder('桌面夹').waitFor();
    assert.equal(await allBranches().count(), 0);
    await folder('桌面夹').dblclick();
    await folder('阅读资料').waitFor();
    check('project previews show saved directional arrows, bends and rendered names; double-clicking opens the real folder');

    await crumb('项目首页').click();
    const moving = await point(folder('另一项目')), destination = await point(folder('桌面夹'));
    await page.mouse.move(moving.x, moving.y); await page.mouse.down();
    await page.mouse.move(destination.x, destination.y, { steps: 12 });
    await page.locator('.is-drop-project').waitFor();
    await page.mouse.up();
    await folder('另一项目').waitFor({ state: 'detached' });
    assert.equal(await rootArrow.count(), 0);
    await folder('桌面夹').dblclick(); await folder('另一项目').waitFor();
    await drag(await point(port('阅读资料'), null), await point(folder('另一项目')));
    await waitArrow(arrow('阅读资料', '另一项目'));
    await folder('另一项目').dblclick(); await board('另一项目的白板').waitFor();
    check('reparenting preserves content and hides arrows across levels; folders can also connect inside a project');

    await crumb('桌面夹').click();
    await folder('另一项目').click({ button: 'right' });
    await menuItem('移到项目…').click(); await menuItem('项目首页').click();
    await folder('另一项目').waitFor({ state: 'detached' });
    await crumb('项目首页').click(); await folder('另一项目').waitFor();
    await waitArrow(rootArrow);
    await folder('桌面夹').click({ button: 'right' });
    assert.equal(await menuItem('先移出子项目再删除').isEnabled(), false);
    await menuItem('移到项目…').click();
    assert.equal(await menuItem('桌面夹 / 阅读资料').count(), 0);
    await page.keyboard.press('Escape');
    check('projects can move back to root; the UI excludes descendant destinations and protects nested folders from deletion');

    await page.evaluate(() => { window.__fixtureNavigationFailure = true; });
    const restartPoint = await point(folder('第三个项目'));
    const restartPosition = (await positions())[rootFolder.id];
    await drag(restartPoint, { x: restartPoint.x + 45, y: restartPoint.y + 85 });
    await page.locator('.error-bar').filter({ hasText: '合成磁盘写入失败' }).waitFor();
    // The error banner shifts the whole canvas. The card should roll back within that canvas.
    assert.deepEqual((await positions())[rootFolder.id], restartPosition);
    assert.deepEqual((await saved()).layout.projects[rootFolder.id].position, rootPosition);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await folder('第三个项目').waitFor();
    assert.equal(await trail(), '项目首页');
    await waitArrow(rootArrow);
    assert.deepEqual(await point(folder('第三个项目')), restartPoint);
    await folder('桌面夹').dblclick();
    await waitArrow(arrow('阅读资料', '补充白板'));
    await waitArrow(boardArrow);
    assert.match(await boardArrow.getAttribute('d'), / Q /);
    await page.locator('.project-relation-names .katex').waitFor();
    await folder('阅读资料').dblclick(); await folder('第三层').dblclick();
    await board('最深白板').waitFor();
    check('failed writes roll back the visual move; restart opens root and preserves all saved levels');

    const favorite = (kind, name) => page.getByRole('button', { name: `收藏置顶${kind}：${name}`, exact: true });
    const favoriteStyle = mark => mark.evaluate(el => {
      const style = getComputedStyle(el);
      return [style.color, style.backgroundColor, style.width, style.height, style.borderRadius, el.querySelector('svg').getAttribute('fill')];
    });
    await favorite('白板', '最深白板').click();
    assert.equal(await favorite('白板', '最深白板').getAttribute('aria-pressed'), 'true');
    await crumb('桌面夹').click();
    await favorite('白板', '合成学习白板').click();
    await favorite('项目', '阅读资料').click();
    const boardStar = await favoriteStyle(favorite('白板', '合成学习白板'));
    const folderStar = await favoriteStyle(favorite('项目', '阅读资料'));
    await crumb('项目首页').click();
    await folder('桌面夹').click();
    await settled('project');
    const previewStar = name => allBranches().filter({ has: page.getByRole('button', { name, exact: true }) }).getByRole('img', { name: '已收藏', exact: true });
    assert.deepEqual(await favoriteStyle(previewStar('合成学习白板')), boardStar);
    assert.deepEqual(await favoriteStyle(previewStar('阅读资料')), folderStar);
    assert.equal(await previewStar('补充白板').count(), 0);
    assert.deepEqual(await previewStar('合成学习白板').evaluate(el => {
      const style = getComputedStyle(el);
      return [style.opacity, style.pointerEvents];
    }), ['1', 'none']);
    const glow = card => card.locator('.project-folder-favorite-effect');
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    const effects = settings.getByRole('group', { name: '文件夹收藏特效' });
    const closeSettings = () => page.keyboard.press('Escape');
    const openSettings = () => page.getByRole('button', { name: '设置', exact: true }).click();
    assert.equal(await glow(folder('桌面夹')).count(), 1);
    assert.equal(await glow(reading).count(), 1);
    assert.equal(await glow(folder('第三个项目')).count(), 0);
    assert.equal(await glow(board('合成学习白板')).count(), 0);
    assert.notEqual(await glow(folder('桌面夹')).evaluate(el => getComputedStyle(el, '::after').boxShadow), 'none');
    await openSettings();
    assert.equal(await effects.getByRole('button', { name: '荧光', exact: true }).getAttribute('aria-pressed'), 'true');
    await effects.getByRole('button', { name: '流光', exact: true }).click();
    await closeSettings();
    const aurora = reading.locator('.project-folder-aurora');
    await aurora.waitFor();
    const wave = () => aurora.evaluate(el => {
      const layer = getComputedStyle(el, '::before'), spectrum = getComputedStyle(el, '::after');
      return [layer.transform, spectrum.transform];
    });
    const firstWave = await wave();
    await page.waitForTimeout(360);
    const secondWave = await wave();
    assert.ok(firstWave.every((value, index) => value !== secondWave[index]));
    assert.ok(await aurora.evaluate(el => {
      const folder = el.closest('.project-folder-artwork').getBoundingClientRect();
      const light = el.getBoundingClientRect();
      const lip = folder.top + folder.height * 15 / 70;
      return light.top < folder.top && Math.abs(light.bottom - lip) <= 3 && !!el.closest('.project-folder-favorite-effect');
    }));
    await page.mouse.move(1400, 170);
    await page.screenshot({ path: path.join(evidence, 'project-preview-favorites.png') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await aurora.evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await reading.click(); await settled(readingId);
    await deep.click(); await settled(deepest.id);
    await previewStar('最深白板').waitFor();
    await deepPreview.click();
    await page.locator('.board-canvas-live').waitFor();
    assert.equal(await trail(), '最深白板');
    check('favorites display the same persistent star on expanded folder and whiteboard cards, including nested previews');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await folder('桌面夹').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-folder-favorite-effect'), 'aurora');
    await openSettings();
    assert.equal(await effects.getByRole('button', { name: '流光', exact: true }).getAttribute('aria-pressed'), 'true');
    await settings.getByRole('switch', { name: '动画', exact: true }).click();
    await closeSettings();
    assert.equal(await folder('桌面夹').locator('.project-folder-aurora').evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
    check('folder effects count nested favorites, default to a neon rim, animate the aurora and persist the selected effect');

    const design = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
    await design.goto(address + '&catalogDesignQA', { waitUntil: 'domcontentloaded' });
    await design.getByRole('button', { name: '研究笔记', exact: true }).dblclick();
    await design.getByRole('button', { name: '讨论脉络', exact: true }).waitFor();
    await design.mouse.move(1400, 170);
    await design.screenshot({ path: path.join(evidence, 'project-canvas-reference-size.png'), animations: 'disabled' });
    for (const theme of ['light', 'paper', 'dark']) {
      await design.setViewportSize({ width: 720, height: 480 });
      await design.evaluate(async theme => {
        const { DEFAULT_SETTINGS, applySettings } = await import('/src/settings.ts');
        applySettings({ ...DEFAULT_SETTINGS, theme, glass: false }, 'macos');
      }, theme);
      for (const name of ['设置', '菜单', '新建']) {
        const box = await design.getByRole('button', { name, exact: true }).boundingBox();
        assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 721 && box.y + box.height <= 481);
      }
      await design.getByRole('button', { name: /显示全部/ }).click();
      await design.screenshot({ path: path.join(evidence, 'project-canvas-720-' + theme + '.png'), animations: 'disabled' });
      await design.getByRole('button', { name: '讨论脉络', exact: true }).click({ button: 'right' });
      await design.getByRole('menuitem', { name: '重命名', exact: true }).click();
      const rename = design.getByRole('dialog', { name: '重命名', exact: true });
      await checkNameDialog(rename, `project-name-720-${theme}.png`);
      await rename.getByRole('button', { name: '取消', exact: true }).click();
    }
    await design.close();
    assert.deepEqual(errors, []);
    check('the project canvas and naming dialog fit 720×480 in three themes; heading, input and buttons clear the dialog corners');
    fs.writeFileSync(path.join(evidence, 'project-canvas-qa.json'), JSON.stringify({ checks, errors, realProviderCalls: 0 }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, 'project-canvas-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
