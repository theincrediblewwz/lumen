// Render the real workspace assistant and replay synthetic provider/IPC responses.
// Native staging, application and byte-for-byte rollback are tested in workspace_ai::tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webkit, chromium } = require(process.env.LSQ_PLAYWRIGHT_MODULE || 'playwright');

const base = process.env.LSQ_UI_URL || 'http://127.0.0.1:5198';
const output = process.env.LSQ_UI_EVIDENCE || 'output/playwright';
const fixture = base + '/scripts/knowledge-ui-fixture.html?platform=macos&mode=main';
fs.mkdirSync(output, { recursive: true });

async function main() {
  const browser = await (process.env.LSQ_UI_BROWSER === 'webkit' ? webkit : chromium).launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture);
    const open = page.getByRole('button', { name: 'AI 工作区', exact: true });
    await open.waitFor();
    const addBox = await page.getByRole('button', { name: '新建项目', exact: true }).boundingBox();
    const openBox = await open.boundingBox();
    assert.ok(openBox.x + openBox.width < addBox.x);
    await page.evaluate(() => {
      localStorage.setItem('lumen.ai.v1', JSON.stringify({
        kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'gpt-4o-mini',
        contextBudget: 8000, temperature: 0, keyStorage: 'system',
      }));
      const native = window.__TAURI_INTERNALS__.invoke;
      const at = '2026-11-19T01:00:00Z';
      const project = { id: 'p_generated', name: '方程讲义', created_at: at };
      const board = { id: 'b_generated', name: '求解路径', updated_at: at };
      const receipt = { id: 'synthetic-plan', appliedAt: at, changeCount: 4, destinations: [
        { projectId: project.id, boardId: null, name: project.name },
        { projectId: project.id, boardId: board.id, name: board.name },
      ] };
      const view = window.__workspaceQA = { reads: [], prepares: [], applies: 0, discards: 0, undos: 0, requests: [] };
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'workspace_ai_latest') return view.applies > view.undos ? receipt : null;
        if (command === 'workspace_ai_read') {
          view.reads.push(args);
          return { data: { rows: [{ projectId: 'project', name: '桌面夹' }], nextOffset: null }, revisions: { 'index.json': 'synthetic-index' } };
        }
        if (command === 'workspace_ai_prepare') {
          view.prepares.push(args);
          return { ...receipt, changes: [
            { action: '新建项目', location: '桌面夹 / 方程讲义', before: null, after: null, removes: false },
            { action: '新建白板', location: '方程讲义 / 求解路径', before: null, after: null, removes: false },
            { action: '新建节点', location: '求解路径 / 线性方程', before: null, after: '# 完整问题\n\n$\\nu x=f$', removes: false },
            { action: '设置子流程顺序', location: '线性方程', before: '', after: '1. 列式\n2. 代回检验', removes: false },
          ] };
        }
        if (command === 'workspace_ai_discard') { view.discards++; return; }
        if (command === 'workspace_ai_apply') { view.applies++; return receipt; }
        if (command === 'workspace_ai_undo') { view.undos++; return; }
        if (command === 'projects_list') {
          const rows = await native(command, args);
          if (view.applies > view.undos) rows.push(project);
          return rows;
        }
        if (command === 'project_canvas_read') {
          const result = await native(command, args);
          if (view.applies > view.undos) result.layout.projects[project.id] = { parentId: 'project' };
          return result;
        }
        if (command === 'boards_list' && args.projectId === project.id) return [board];
        if (command === 'ai_chat_stream') {
          const request = JSON.parse(args.body);
          view.requests.push(request);
          const toolCount = request.messages.filter(message => message.role === 'tool').length;
          const tools = (name, args) => ({ tool_calls: [{
            index: 0, id: 'call-qa-' + toolCount, type: 'function', function: { name, arguments: JSON.stringify(args) },
          }] });
          const board = { projectId: '@p', boardId: '@b' };
          const delta = toolCount === 0 ? tools('inspect_workspace', { query: { kind: 'projects', query: '桌面夹' } })
            : toolCount === 1 ? tools('propose_workspace_changes', {
              schema: 'lumen.workspace-operations/v1', operations: [
                { op: 'create_project', key: '@p', name: '方程讲义', parentId: 'project' },
                { op: 'create_board', key: '@b', projectId: '@p', name: '求解路径' },
                { op: 'create_node', key: '@n', board, fields: { title: '线性方程', summary: '$\\nu x=f$' } },
                { op: 'create_node', key: '@s', board, fields: { title: '列式' } },
                { op: 'set_flow', board, ownerId: '@n', stepIds: ['@s'] },
              ],
            }) : { content: '已拟定方案，等待你确认。' };
          const event = 'data: ' + JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n';
          window.__fixtureEmit('ai://chunk', { requestId: args.requestId, data: event });
          window.__fixtureEmit('ai://done', { requestId: args.requestId });
          return;
        }
        return native(command, args);
      };
    });
    const state = () => page.evaluate(() => window.__workspaceQA);
    const modal = page.getByRole('dialog', { name: 'AI 工作区' });
    const input = modal.getByRole('textbox', { name: '输入工作区请求' });
    const send = modal.getByRole('button', { name: '发送工作区请求' });
    const allow = modal.getByRole('checkbox', { name: /允许读取现有白板/ });
    const apply = modal.getByRole('button', { name: '应用方案' });
    const run = async () => {
      await input.fill('在桌面夹下建项目、白板、节点和子流程');
      await send.click();
      await modal.getByText('已拟定方案，等待你确认。', { exact: true }).waitFor();
      await apply.waitFor();
    };

    await open.click();
    assert.equal(await allow.isChecked(), false);
    await run();
    const staged = await state();
    assert.equal(staged.applies, 0);
    assert.equal(staged.reads[0].shareBoardContents, false);
    assert.deepEqual(staged.prepares[0].expectedRevisions, { 'index.json': 'synthetic-index' });
    assert.equal(staged.prepares[0].batch.operations.at(-1).op, 'set_flow');
    assert.ok(!JSON.stringify(staged.requests[0].tools[0]).includes('"attachments"'));
    await modal.getByText('新建节点', { exact: true }).click();
    await modal.getByText(/完整问题/, { exact: false }).filter({ hasText: /nu x=f/ }).last().waitFor();
    await page.screenshot({ path: path.join(output, 'workspace-ai-review.png') });
    await modal.getByRole('button', { name: '取消方案' }).click();
    assert.equal((await state()).discards, 1);
    assert.equal((await state()).applies, 0);

    await allow.check();
    await input.fill('再生成一次');
    await send.click();
    await apply.waitFor();
    assert.equal((await state()).reads.at(-1).shareBoardContents, true);
    assert.ok(JSON.stringify((await state()).requests[3].tools[0]).includes('"attachments"'));
    assert.equal((await state()).requests[3].messages.length, 2);
    await apply.click();
    await modal.getByText('已应用 4 项', { exact: true }).waitFor();
    assert.equal((await state()).applies, 1);

    await modal.getByRole('button', { name: '方程讲义', exact: true }).click();
    await page.getByRole('button', { name: '求解路径', exact: false }).first().waitFor();
    await open.click();
    await page.setViewportSize({ width: 500, height: 720 });
    const box = await modal.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 500);
    await modal.getByRole('button', { name: '撤销上一批' }).click();
    await modal.getByText('已撤销上一批变更', { exact: true }).waitFor();
    assert.equal((await state()).undos, 1);
    assert.deepEqual(errors, []);

    fs.writeFileSync(path.join(output, 'workspace-ai-qa.json'), JSON.stringify({
      passed: true, makePlan: true, apply: true, discard: true, navigate: true, undo: true,
      sharedScopeChecked: true, realProviderCalls: 0, nativeFilesystemVerifiedSeparately: true,
    }, null, 2));
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
