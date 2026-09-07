/**
 * 阅读器偏好与进度（M4-6）：字号、阅读模式、每篇文档的阅读进度记忆。
 * 全部持久化到 localStorage，key 与白板设置分开命名空间。
 *
 * 主题不再由阅读器单独管理——阅读器跟随软件主体主题（ADR-027）。
 */

/** 阅读模式：single=单页连续（一栏铺满）；double=双页连续（左右两页，向下连续滚动） */
export type ReaderMode = 'single' | 'double';

export interface ReaderPrefs {
  /** 字号缩放百分比，60–150 */
  fontScale: number;
  mode: ReaderMode;
  /** 目录是否收起 */
  tocCollapsed?: boolean;
}

const PREFS_KEY = 'lumen.reader.prefs.v3';
const PROGRESS_KEY = 'lumen.reader.progress.v1';

export const FONT_MIN = 60;
export const FONT_MAX = 150;
export const FONT_STEP = 10;

const DEFAULT_PREFS: ReaderPrefs = { fontScale: 100, mode: 'single', tocCollapsed: false };

export function loadPrefs(): ReaderPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const p = JSON.parse(raw) as Partial<Omit<ReaderPrefs, 'mode'>> & { mode?: string };
    // 兼容旧值：continuous→single、paged→double
    const mode: ReaderMode = p.mode === 'double' || p.mode === 'paged' ? 'double' : 'single';
    return {
      fontScale: clampFont(typeof p.fontScale === 'number' ? p.fontScale : 100),
      mode,
      tocCollapsed: !!p.tocCollapsed,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p: ReaderPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* 忽略 quota / 隐私模式错误 */
  }
}

export function clampFont(v: number): number {
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(v / FONT_STEP) * FONT_STEP));
}

/* ── 阅读进度：按文档 key 记录滚动比例 0..1 ── */

type ProgressMap = Record<string, number>;

function readProgressMap(): ProgressMap {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}') as ProgressMap;
  } catch {
    return {};
  }
}

export function getProgress(docKey: string): number {
  const m = readProgressMap();
  const v = m[docKey];
  return typeof v === 'number' && v >= 0 && v <= 1 ? v : 0;
}

export function setProgress(docKey: string, ratio: number) {
  const m = readProgressMap();
  m[docKey] = Math.max(0, Math.min(1, ratio));
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(m));
  } catch {
    /* 忽略 */
  }
}

