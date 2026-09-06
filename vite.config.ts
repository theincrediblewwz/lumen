import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri 开发模式下由 TAURI_DEV_HOST 指定监听地址（供移动端/局域网调试）
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],

  // 交给 Tauri 接管清屏，避免开发日志被冲掉
  clearScreen: false,

  server: {
    // 不用 Tauri 模板默认的 1420：在部分 Windows 机器上该端口被
    // Hyper-V / WSL 的动态端口保留段排除，Node 会报 EACCES。
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5174 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },

  // Tauri 通过 TAURI_* 前缀注入环境变量
  envPrefix: ['VITE_', 'TAURI_'],

  build: {
    // WebView2 基于 Chromium；macOS 为 WKWebView（Safari 内核）
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
