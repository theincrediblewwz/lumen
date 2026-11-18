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
  const port = name => page.getByRole('button', { name: `从${name}拉出项目连线`, exact: true });
  const arrow = (from, to) => page.getByRole('button', { name: `${from} → ${to}`, exact: true });
  const crumb = name => page.getByRole('navigation', { name: '项目路径' }).getByRole('button', { name, exact: true });
  const canvas = () => page.locator('.project-canvas');
  const trail = () => page.locator('.project-path [aria-current=page]').innerText();
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('lumen.fixture-navigation')));
  const menuItem = name => page.getByRole('menuitem', { name, exact: true });
  const point = async (locator, offsetY = 32) => {
    const rect = await locator.boundingBox();
    assert.ok(rect);
    return { x: rect.x + rect.width / 2, y: rect.y + (offsetY ?? rect.height / 2) };
  };
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up();
  };
  const newItem = async (kind, title, root = false) => {
    await page.getByRole('button', { name: root ? '新建项目' : '新建', exact: true }).click();
    if (!root) await menuItem(kind === 'project' ? '新建项目' : '新建白板').click();
    const input = page.getByRole('textbox', { name: '名称', exact: true });
    await input.fill(title); await input.press('Enter');
    await (kind === 'project' ? folder(title) : board(title)).waitFor();
  };
  try {
    await page.goto(address + '&projectCanvasQA&nodes', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await canvas().waitFor();
    assert.equal(await trail(), '项目首页');
    assert.equal(await page.locator('.project-tile.is-project').count(), 2);
    assert.equal(await page.locator('.project-tile.is-board, .sidebar').count(), 0);
    await canvas().click({ button: 'right', position: { x: 800, y: 250 } });
    await menuItem('新建项目').waitFor();
    assert.equal(await menuItem('新建白板').count(), 0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('.settings-card').waitFor(); await page.keyboard.press('Escape');
    check('legacy projects appear directly on root canvas with no sidebar or root board creation');

    await newItem('project', '第三个项目', true);
    const start = await point(folder('第三个项目'));
    await drag(start, { x: start.x + 160, y: start.y + 260 });
    const rootFolder = (await saved()).projects.find(project => project.name === '第三个项目');
    const rootPosition = (await saved()).layout.projects[rootFolder.id].position;
    assert.ok(rootPosition.x > 500 && rootPosition.y > 300);
    assert.equal(await trail(), '项目首页');
    check('dragging a project persists its position without opening it');

    await folder('桌面夹').hover();
    const source = await point(port('桌面夹'), null);
    const target = await point(folder('另一项目'));
    await page.mouse.move(source.x, source.y); await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 12 });
    await page.locator('.project-relation-draft').waitFor();
    await page.locator('.project-tile.is-connection-target').filter({ hasText: '另一项目' }).waitFor();
    await page.mouse.up();
    const rootArrow = arrow('桌面夹', '另一项目');
    await rootArrow.waitFor();
    assert.deepEqual((await saved()).layout.relations, [{ from: 'project', to: 'project-other' }]);
    assert.equal(await trail(), '项目首页');
    const firstPath = await rootArrow.getAttribute('d');
    await drag(target, { x: target.x + 96, y: target.y + 155 });
    await page.waitForFunction(d => document.querySelector('.project-relation-hit')?.getAttribute('d') !== d, firstPath);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('lumen.fixture-navigation')).layout.projects['project-other']?.position?.y > 200);
    assert.equal(await rootArrow.getAttribute('d') === firstPath, false);
    await page.mouse.move(960, 155);
    await page.screenshot({ path: path.join(evidence, 'project-canvas-relations.png'), animations: 'disabled' });
    check('dragging from the folder port previews a directional arrow, snaps to the target, and follows its new position');

    await port('另一项目').press('Enter');
    await menuItem('连到项目…').click(); await menuItem('桌面夹').click();
    const reverse = arrow('另一项目', '桌面夹');
    await reverse.waitFor();
    assert.notEqual(await rootArrow.getAttribute('d'), await reverse.getAttribute('d'));
    await reverse.press('Enter'); await menuItem('删除连线').click();
    await reverse.waitFor({ state: 'detached' });
    assert.equal(await rootArrow.count(), 1);
    check('keyboard menus can create the reverse arrow and remove just that direction');

    await folder('桌面夹').click();
    await board('合成学习白板').waitFor();
    await newItem('project', '阅读资料');
    await newItem('board', '补充白板');
    await drag(await point(port('阅读资料'), null), await point(board('补充白板')));
    assert.equal(await page.locator('.project-relation').count(), 0);
    assert.equal(await trail(), '桌面夹');
    assert.equal(await page.locator('.project-tile.is-project').count(), 1);
    assert.equal(await page.locator('.project-tile.is-board').count(), 3);
    const originalBoard = (await saved()).boards.find(row => row.id === 'board');
    const boardStart = await point(board('合成学习白板'));
    await drag(boardStart, { x: boardStart.x + 250, y: boardStart.y + 295 });
    const boardPosition = (await saved()).layout.boards.project.board;
    assert.ok(boardPosition.x > 400 && boardPosition.y > 350);
    assert.deepEqual((await saved()).boards.find(row => row.id === 'board'), originalBoard);
    check('a project can contain both kinds of tile and moving a board card leaves board content intact');

    await page.mouse.move(850, 450); await page.mouse.wheel(0, 200);
    await page.waitForFunction(() => Number(document.querySelector('.project-canvas')?.dataset.zoom) < 1);
    const transform = await page.locator('.project-canvas-world').getAttribute('style');
    await folder('阅读资料').click();
    await newItem('project', '第三层');
    await folder('第三层').click();
    await newItem('board', '最深白板');
    await board('最深白板').click(); await page.locator('.board-canvas-live').waitFor();
    assert.equal(await trail(), '最深白板');
    assert.equal(await crumb('阅读资料').count(), 1);
    await crumb('桌面夹').click(); await board('补充白板').waitFor();
    assert.equal(await page.locator('.project-canvas-world').getAttribute('style'), transform);
    assert.deepEqual((await saved()).layout.boards.project.board, boardPosition);
    check('three project levels and the board appear in the path; jumping back restores the camera and positions');

    await crumb('项目首页').click();
    const moving = await point(folder('另一项目')), destination = await point(folder('桌面夹'));
    await page.mouse.move(moving.x, moving.y); await page.mouse.down();
    await page.mouse.move(destination.x, destination.y, { steps: 12 });
    await page.locator('.is-drop-project').waitFor();
    await page.mouse.up();
    await folder('另一项目').waitFor({ state: 'detached' });
    assert.equal(await rootArrow.count(), 0);
    await folder('桌面夹').click(); await folder('另一项目').waitFor();
    await drag(await point(port('阅读资料'), null), await point(folder('另一项目')));
    await arrow('阅读资料', '另一项目').waitFor();
    await folder('另一项目').click(); await board('另一项目的白板').waitFor();
    check('reparenting preserves content and hides arrows across levels; folders can also connect inside a project');

    await crumb('桌面夹').click();
    await folder('另一项目').click({ button: 'right' });
    await menuItem('移到项目…').click(); await menuItem('项目首页').click();
    await folder('另一项目').waitFor({ state: 'detached' });
    await crumb('项目首页').click(); await folder('另一项目').waitFor();
    await rootArrow.waitFor();
    await folder('桌面夹').click({ button: 'right' });
    assert.equal(await menuItem('先移出子项目再删除').isEnabled(), false);
    await menuItem('移到项目…').click();
    assert.equal(await menuItem('桌面夹 / 阅读资料').count(), 0);
    await page.keyboard.press('Escape');
    check('projects can move back to root; the UI excludes descendant destinations and protects nested folders from deletion');

    await page.evaluate(() => { window.__fixtureNavigationFailure = true; });
    const restartPoint = await point(folder('第三个项目'));
    await drag(restartPoint, { x: restartPoint.x + 45, y: restartPoint.y + 85 });
    await page.locator('.error-bar').filter({ hasText: '合成磁盘写入失败' }).waitFor();
    assert.deepEqual(await point(folder('第三个项目')), restartPoint);
    assert.deepEqual((await saved()).layout.projects[rootFolder.id].position, rootPosition);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await folder('第三个项目').waitFor();
    assert.equal(await trail(), '项目首页');
    await rootArrow.waitFor();
    assert.deepEqual(await point(folder('第三个项目')), restartPoint);
    await folder('桌面夹').click(); await folder('阅读资料').click(); await folder('第三层').click();
    await board('最深白板').waitFor();
    check('failed writes roll back the visual move; restart opens root and preserves all saved levels');

    const design = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
    await design.goto(address + '&catalogDesignQA', { waitUntil: 'domcontentloaded' });
    await design.getByRole('button', { name: '研究笔记', exact: true }).click();
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
    }
    await design.close();
    assert.deepEqual(errors, []);
    check('the project canvas and controls fit 720×480 in three themes; the reference layout renders at its native size');
    fs.writeFileSync(path.join(evidence, 'project-canvas-qa.json'), JSON.stringify({ checks, errors, realProviderCalls: 0 }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, 'project-canvas-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
