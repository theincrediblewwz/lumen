import { expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { api, type BoardFile } from './api';

it('adopts the exact post-rename snapshot revision without requiring a second load', async () => {
  const board: BoardFile = { version: 1, id: 'rename-board', projectId: 'project', name: '旧名', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, created_at: '', updated_at: '', _disk_revision: 'before' };
  invoke.mockImplementation(async (command, args) => {
    if (command === 'board_load') return board;
    if (command === 'board_rename') return { ...board, name: args.name, _disk_revision: 'after' };
    if (command === 'board_save') { expect(args.expectedRevision).toBe('after'); expect(args.board.name).toBe('新名'); return 'saved'; }
    throw Error('unexpected command');
  });
  await api.boardLoad('project', board.id);
  const renamed = await api.boardRename('project', board.id, '新名');
  await api.boardSave({ ...renamed, viewport: { x: 10, y: 20, zoom: 1 } });
  expect(invoke.mock.calls.filter(([command]) => command === 'board_load')).toHaveLength(1);
});
