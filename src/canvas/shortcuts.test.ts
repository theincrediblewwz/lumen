import { describe, it, expect } from 'vitest';
import {
  parseCombo,
  matchCombo,
  matchShortcut,
  formatCombo,
  formatShortcut,
  normalizeEventKey,
  isEditableTarget,
  isMac,
  SHORTCUTS,
  shortcut,
} from './shortcuts';

type EvtLike = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};
const ev = (key: string, mods: Partial<EvtLike> = {}): EvtLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('parseCombo', () => {
  it('解析修饰键与主键', () => {
    const c = parseCombo('mod+shift+z');
    expect(c.mod).toBe(true);
    expect(c.shift).toBe(true);
    expect(c.key).toBe('z');
  });
  it('别名归一（cmd/command→meta，control→ctrl，option→alt）', () => {
    expect(parseCombo('cmd+k').meta).toBe(true);
    expect(parseCombo('control+a').ctrl).toBe(true);
    expect(parseCombo('option+x').alt).toBe(true);
  });
  it('空串返回空壳', () => {
    expect(parseCombo('').key).toBe('');
  });
});

describe('normalizeEventKey', () => {
  it('空格归一为 space', () => {
    expect(normalizeEventKey(' ')).toBe('space');
  });
  it('大写归一为小写', () => {
    expect(normalizeEventKey('K')).toBe('k');
    expect(normalizeEventKey('ArrowUp')).toBe('arrowup');
  });
});

describe('matchCombo — mod 平台映射', () => {
  it('mac 上 mod=meta', () => {
    expect(matchCombo(ev('k', { metaKey: true }), 'mod+k', { mac: true })).toBe(true);
    expect(matchCombo(ev('k', { ctrlKey: true }), 'mod+k', { mac: true })).toBe(false);
  });
  it('非 mac 上 mod=ctrl', () => {
    expect(matchCombo(ev('k', { ctrlKey: true }), 'mod+k', { mac: false })).toBe(true);
    expect(matchCombo(ev('k', { metaKey: true }), 'mod+k', { mac: false })).toBe(false);
  });
});

describe('matchCombo — 精确修饰匹配', () => {
  it('多余修饰键不命中', () => {
    // 期望 mod+z（win: ctrl+z），但按了 ctrl+shift+z
    expect(matchCombo(ev('z', { ctrlKey: true, shiftKey: true }), 'mod+z', { mac: false })).toBe(
      false,
    );
  });
  it('shift+z 明确要求 shift', () => {
    expect(matchCombo(ev('z', { ctrlKey: true, shiftKey: true }), 'mod+shift+z', { mac: false })).toBe(
      true,
    );
  });
  it('裸键要求无修饰', () => {
    expect(matchCombo(ev('n'), 'n')).toBe(true);
    expect(matchCombo(ev('n', { ctrlKey: true }), 'n')).toBe(false);
  });
  it('方向键', () => {
    expect(matchCombo(ev('ArrowUp'), 'arrowup')).toBe(true);
  });
});

describe('matchShortcut — 多 combo', () => {
  it('重做支持 mod+shift+z 与 mod+y', () => {
    const redo = shortcut('redo')!;
    expect(matchShortcut(ev('z', { ctrlKey: true, shiftKey: true }), redo, { mac: false })).toBe(
      true,
    );
    expect(matchShortcut(ev('y', { ctrlKey: true }), redo, { mac: false })).toBe(true);
    expect(matchShortcut(ev('z', { ctrlKey: true }), redo, { mac: false })).toBe(false);
  });
  it('删除支持 Delete 与 Backspace', () => {
    const del = shortcut('delete')!;
    expect(matchShortcut(ev('Delete'), del)).toBe(true);
    expect(matchShortcut(ev('Backspace'), del)).toBe(true);
  });
});

describe('formatCombo', () => {
  it('mac 用符号无分隔', () => {
    expect(formatCombo('mod+k', { mac: true })).toBe('⌘K');
    expect(formatCombo('mod+shift+z', { mac: true })).toBe('⌘⇧Z');
  });
  it('win 用 Ctrl+ 文字', () => {
    expect(formatCombo('mod+k', { mac: false })).toBe('Ctrl+K');
    expect(formatCombo('mod+shift+z', { mac: false })).toBe('Ctrl+Shift+Z');
  });
  it('特殊键映射', () => {
    expect(formatCombo('arrowup', { mac: false })).toBe('↑');
    expect(formatCombo('escape', { mac: false })).toBe('Esc');
    expect(formatCombo('shift+/', { mac: false })).toBe('Shift+/');
  });
  it('formatShortcut 取首选 combo', () => {
    expect(formatShortcut(shortcut('redo')!, { mac: false })).toBe('Ctrl+Shift+Z');
  });
});

describe('isEditableTarget', () => {
  it('input/textarea/select 命中', () => {
    expect(isEditableTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true);
  });
  it('contentEditable 命中', () => {
    expect(
      isEditableTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget),
    ).toBe(true);
  });
  it('普通元素与 null 不命中', () => {
    expect(isEditableTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('isMac 注入', () => {
  it('按传入 platform 判定', () => {
    expect(isMac('MacIntel')).toBe(true);
    expect(isMac('Win32')).toBe(false);
    expect(isMac('Linux x86_64')).toBe(false);
  });
});

describe('SHORTCUTS 表', () => {
  it('id 唯一', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('每项至少一个 combo 且能被格式化', () => {
    for (const s of SHORTCUTS) {
      expect(s.combos.length).toBeGreaterThan(0);
      expect(formatShortcut(s, { mac: false }).length).toBeGreaterThan(0);
    }
  });
});
