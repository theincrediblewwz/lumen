const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webkit } = require(process.env.LSQ_PLAYWRIGHT_MODULE || 'playwright');

const base = process.env.LSQ_UI_URL || 'http://127.0.0.1:5198';
const evidence = path.resolve(process.env.LSQ_UI_EVIDENCE || 'mac-ui-evidence');

(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  const browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const dialog = page.getByRole('dialog', { name: '更换封面', exact: true });
  const tile = name => page.locator('.project-canvas').getByRole('button', { name, exact: true });
  const cover = name => dialog.getByRole('radio', { name, exact: true });
  const apply = dialog.getByRole('button', { name: '应用封面', exact: true });
  const pick = name => dialog.getByText(name, { exact: true }).click();
  const current = async name => {
    const img = tile(name).locator('img.project-cover-image');
    await img.waitFor();
    await page.waitForFunction(element => element.naturalWidth === 720, await img.elementHandle());
    return img.getAttribute('src');
  };
  const choose = async (name, keyboard = false) => {
    if (keyboard) await tile(name).press('Shift+F10');
    else await tile(name).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '更换封面…', exact: true }).click();
    await dialog.waitFor();
  };
  const save = async () => { await apply.click(); await dialog.waitFor({ state: 'hidden' }); };

  try {
    await page.goto(`${base}/scripts/knowledge-ui-fixture.html?mode=main&platform=macos&projectCanvasQA`);
    await choose('桌面夹', true);
    assert.equal(await dialog.getByRole('radio').count(), 45);
    assert.equal(await dialog.locator('[data-cover-style]').count(), 6);
    assert.equal(await cover('默认封面').isChecked(), true);
    assert.equal(await apply.isDisabled(), true);
    await pick('芦苇晨雾');
    assert.equal(await cover('芦苇晨雾').isChecked(), true);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-id') === 'project');
    assert.equal(await tile('桌面夹').locator('img').count(), 0);

    await choose('桌面夹');
    await page.screenshot({ path: path.join(evidence, 'project-covers-gallery.png'), animations: 'disabled' });
    await pick('芦苇晨雾');
    await save();
    assert.match(await current('桌面夹'), /reed-morning-mist/);
    const silhouette = await tile('桌面夹').locator('.project-folder-surface').evaluate(surface => {
      const image = surface.querySelector('img');
      const base = surface.getBoundingClientRect();
      const art = image.getBoundingClientRect();
      return { clipped: getComputedStyle(surface).clipPath !== 'none',
        unbroken: base.top === art.top && base.width === art.width && base.height === art.height };
    });
    assert.deepEqual(silhouette, { clipped: true, unbroken: true });
    assert.equal(await tile('另一项目').locator('img').count(), 0);
    await page.screenshot({ path: path.join(evidence, 'project-covers-folder.png'), animations: 'disabled' });

    await tile('桌面夹').click();
    await choose('合成学习白板');
    await pick('极光冰湖');
    await page.evaluate(() => { window.__fixtureNavigationFailure = true; });
    await apply.click();
    await dialog.getByRole('alert').filter({ hasText: '合成磁盘写入失败' }).waitFor();
    assert.equal(await cover('极光冰湖').isChecked(), true);
    assert.equal(await tile('合成学习白板').locator('img').count(), 0);
    await page.evaluate(() => { window.__fixtureNavigationFailure = false; });
    await save();
    assert.match(await current('合成学习白板'), /aurora-lake/);
    await page.screenshot({ path: path.join(evidence, 'project-covers-board.png'), animations: 'disabled' });

    await page.reload();
    assert.match(await current('桌面夹'), /reed-morning-mist/);
    await tile('桌面夹').click();
    assert.match(await current('合成学习白板'), /aurora-lake/);
    await choose('合成学习白板');
    await pick('暖棕皮革');
    await save();
    await tile('合成学习白板').locator('[data-cover-style="saddle-leather"]').waitFor();
    await page.reload();
    await tile('桌面夹').click();
    await tile('合成学习白板').locator('[data-cover-style="saddle-leather"]').waitFor();
    await page.setViewportSize({ width: 720, height: 480 });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await choose('合成学习白板');
    assert.equal(await cover('暖棕皮革').isChecked(), true);
    await pick('巨杉晨光');
    assert.equal(await cover('巨杉晨光').isChecked(), true);
    await page.waitForFunction(() => [...document.querySelectorAll('.cover-option')].at(-1)?.querySelector('img')?.naturalWidth === 720);
    const bounds = await apply.boundingBox();
    assert.ok(bounds && bounds.y + bounds.height <= 480);
    await page.screenshot({ path: path.join(evidence, 'project-covers-720-dark.png'), animations: 'disabled' });
    await pick('默认封面');
    await save();
    assert.equal(await tile('合成学习白板').locator('.project-cover-image').count(), 0);
    await page.reload();
    assert.match(await current('桌面夹'), /reed-morning-mist/);
    await tile('桌面夹').click();
    await tile('合成学习白板').waitFor();
    assert.equal(await tile('合成学习白板').locator('.project-cover-image').count(), 0);
    await tile('合成学习白板').click();
    await page.locator('.board-canvas-live').waitFor();
    assert.deepEqual(errors, []);
    console.log('Project and board covers: 38 offline images, six styles, complete folder clipping, keyboard menu, cancel, retry, reload, scrolling, reset, and board navigation passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
