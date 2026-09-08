/**
 * 快捷键体系（M6-9）——集中定义、平台感知、可测试的纯逻辑。
 *
 * combo 语法：以 `+` 连接修饰键与主键，全小写。
 *   修饰键：`mod`（mac=⌘ / 其它=Ctrl）、`ctrl`、`meta`、`shift`、`alt`
 *   主键：单字符（`k`、`=`、`-`、`0`、`/`）或特殊名（`arrowup`/`arrowdown`/`arrowleft`/`arrowright`/`escape`/`delete`/`backspace`/`enter`/`f11`）
 * 例：`mod+k`、`mod+shift+z`、`shift+/`、`n`、`arrowup`
 */

export type ShortcutGroup = '全局' | '画布' | '节点' | '视图';

export interface ShortcutDef {
  id: string;
  /** 一个或多个等效 combo（命中任一即触发） */
  combos: string[];
  label: string;
  group: ShortcutGroup;
}

/** 是否 macOS（用于 ⌘/Ctrl 映射与显示）。允许注入 platform 便于测试。 */
export function isMac(platform?: string): boolean {
  const p =
    platform ??
    (typeof navigator !== 'undefined'
      ? // 优先用较新的 userAgentData，回退 platform/userAgent
        ((navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData
          ?.platform ||
        navigator.platform ||
        navigator.userAgent)
      : '');
  return /mac|iphone|ipad|ipod/i.test(p);
}

interface ParsedCombo {
  mod: boolean; // 平台主修饰（mac=meta / 其它=ctrl）
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  key: string; // 归一化后的主键（小写）
}

/** 解析 combo 字符串为结构。非法输入返回 key='' 的空壳（不会命中任何事件）。 */
export function parseCombo(combo: string): ParsedCombo {
  const out: ParsedCombo = {
    mod: false,
    ctrl: false,
    meta: false,
    shift: false,
    alt: false,
    key: '',
  };
  if (!combo) return out;
  const parts = combo.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    switch (p) {
      case 'mod':
        out.mod = true;
        break;
      case 'ctrl':
      case 'control':
        out.ctrl = true;
        break;
      case 'meta':
      case 'cmd':
      case 'command':
        out.meta = true;
        break;
      case 'shift':
        out.shift = true;
        break;
      case 'alt':
      case 'option':
        out.alt = true;
        break;
      default:
        out.key = p;
    }
  }
  return out;
}

/** 归一化 KeyboardEvent.key 到 combo 的主键写法。 */
export function normalizeEventKey(key: string): string {
  const k = key.toLowerCase();
  if (k === ' ' || k === 'spacebar') return 'space';
  return k;
}

/** 判断一个键盘事件是否命中某个 combo（平台感知）。 */
export function matchCombo(
  e: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  combo: string,
  opts: { mac?: boolean } = {},
): boolean {
  const mac = opts.mac ?? isMac();
  const c = parseCombo(combo);
  if (!c.key) return false;
  if (normalizeEventKey(e.key) !== c.key) return false;

  // mod = 平台主修饰键
  const wantCtrl = c.ctrl || (c.mod && !mac);
  const wantMeta = c.meta || (c.mod && mac);
  if (e.ctrlKey !== wantCtrl) return false;
  if (e.metaKey !== wantMeta) return false;
  if (e.shiftKey !== c.shift) return false;
  if (e.altKey !== c.alt) return false;
  return true;
}

/** 事件是否命中定义里的任一 combo。 */
export function matchShortcut(
  e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean },
  def: ShortcutDef,
  opts: { mac?: boolean } = {},
): boolean {
  return def.combos.some((c) => matchCombo(e, c, opts));
}

const SPECIAL_LABEL: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  escape: 'Esc',
  delete: 'Del',
  backspace: '⌫',
  enter: 'Enter',
  space: 'Space',
  '=': '＝',
  '-': '－',
  '/': '/',
};

/** 把单个 combo 格式化为便于阅读的按键串（平台感知）。 */
export function formatCombo(combo: string, opts: { mac?: boolean } = {}): string {
  const mac = opts.mac ?? isMac();
  const c = parseCombo(combo);
  const seg: string[] = [];
  if (c.mod) seg.push(mac ? '⌘' : 'Ctrl');
  if (c.meta && !c.mod) seg.push(mac ? '⌘' : 'Win');
  if (c.ctrl && !c.mod) seg.push('Ctrl');
  if (c.alt) seg.push(mac ? '⌥' : 'Alt');
  if (c.shift) seg.push(mac ? '⇧' : 'Shift');
  const key = SPECIAL_LABEL[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key.replace(/^\w/, (m) => m.toUpperCase()));
  seg.push(key);
  return seg.join(mac ? '' : '+');
}

/** 格式化一个定义的首选 combo（列表展示用）。 */
export function formatShortcut(def: ShortcutDef, opts: { mac?: boolean } = {}): string {
  return formatCombo(def.combos[0], opts);
}

/** 目标是否为可编辑控件（输入框/文本域/可编辑元素）——命中则不触发画布级快捷键。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** 全部快捷键定义（帮助面板与集中匹配共用）。 */
export const SHORTCUTS: ShortcutDef[] = [
  // 全局
  { id: 'search', combos: ['mod+k'], label: '全局搜索', group: '全局' },
  { id: 'help', combos: ['shift+/'], label: '快捷键帮助', group: '全局' },
  { id: 'fullscreen', combos: ['f11'], label: '进入 / 退出全屏', group: '全局' },
  // 视图
  { id: 'zoom-in', combos: ['mod+='], label: '放大', group: '视图' },
  { id: 'zoom-out', combos: ['mod+-'], label: '缩小', group: '视图' },
  { id: 'zoom-reset', combos: ['mod+0'], label: '缩放重置为 100%', group: '视图' },
  { id: 'fit', combos: ['shift+1'], label: '适配全部内容到屏幕', group: '视图' },
  // 画布
  { id: 'new-node', combos: ['n'], label: '在视图中心新建节点', group: '画布' },
  { id: 'undo', combos: ['mod+z'], label: '撤销', group: '画布' },
  { id: 'redo', combos: ['mod+shift+z', 'mod+y'], label: '重做', group: '画布' },
  // 节点
  { id: 'delete', combos: ['delete', 'backspace'], label: '删除选中的节点 / 连线', group: '节点' },
  { id: 'nudge', combos: ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'], label: '微移选中节点（按住 Shift 步长更大）', group: '节点' },
  { id: 'deselect', combos: ['escape'], label: '取消选中 / 关闭面板', group: '节点' },
];

/** 便捷查表（按 id）。 */
export function shortcut(id: string): ShortcutDef | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}
