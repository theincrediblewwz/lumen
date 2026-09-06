/**
 * 应用设置：主题 + 液态玻璃（毛玻璃）外观，持久化到 localStorage。
 *
 * 关于玻璃方案：主目标 macOS 用 WKWebView(Safari 引擎)，SVG 位移折射滤镜在其
 * backdrop-filter 内不生效，业界"真折射"库在 Safari 上都会退化为普通毛玻璃。
 * 因此这里抽取各库共有、跨引擎一致的玻璃核心：分层 backdrop-filter(模糊+提饱和)
 * + 半透明染色 + 亮边高光 + 细噪点。透明度/模糊在设置里可调。
 */

export type ThemeName = 'light' | 'paper' | 'dark';

export type GlassMode = 'native' | 'css' | 'off';

export interface Settings {
  theme: ThemeName;
  glass: boolean;
  /** 玻璃实现方式：native=原生 OS 材质(Mac 液态玻璃/Win Mica)，css=网页毛玻璃，off=关闭 */
  glassMode: GlassMode;
  /** 玻璃"通透度" 0–100：越大越透明（染色越淡、看穿越多） */
  glassClarity: number;
  /** 玻璃模糊强度 0–100 */
  glassBlur: number;
  /** 动画特效开关 */
  motion: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  glass: true,
  glassMode: 'native',
  glassClarity: 55,
  glassBlur: 60,
  motion: true,
};

const KEY = 'lumen.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 忽略隐私模式等写入失败 */
  }
}

/** 把设置映射到 <html> 上的 data-theme / class / CSS 变量。 */
export function applySettings(s: Settings, platform = ''): void {
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  const isMac = platform === 'macos';
  let mode: GlassMode = s.glass ? s.glassMode : 'off';
  // 原生材质仅 macOS 支持；其它平台上"原生"退化为纯实色主题（Win11 Mica 会
  // 取壁纸色且焦点变色，观感不佳，故不在 Windows/Linux 启用，见 ADR-019）。
  if (mode === 'native' && !isMac) mode = 'off';
  // native：窗口透明 + OS 合成材质（body 透明让材质透上来）
  root.classList.toggle('native-glass', mode === 'native');
  // css：网页 backdrop-filter 毛玻璃
  root.classList.toggle('glass-on', mode === 'css');
  root.classList.toggle('motion-off', !s.motion);

  // clarity 0..100 → 表面染色 alpha 0.9(不透明)..0.30(很通透)
  const alpha = 0.9 - (s.glassClarity / 100) * 0.6;
  // blur 0..100 → 6px..34px
  const blur = 6 + (s.glassBlur / 100) * 28;
  root.style.setProperty('--glass-alpha', alpha.toFixed(3));
  root.style.setProperty('--glass-blur', `${blur.toFixed(1)}px`);
}
