import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
const pdfRoot=path.resolve('node_modules/pdfjs-dist');

// Tauri 开发模式下由 TAURI_DEV_HOST 指定监听地址（供移动端/局域网调试）
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), {
    name:'offline-pdf-resources',
    generateBundle(){for(const dir of ['cmaps','standard_fonts','wasm'])for(const name of fs.readdirSync(path.join(pdfRoot,dir))){const file=path.join(pdfRoot,dir,name);if(fs.statSync(file).isFile())this.emitFile({type:'asset',fileName:`pdf-resources/${dir}/${name}`,source:fs.readFileSync(file)});}},
    configureServer(server){server.middlewares.use('/pdf-resources/',(req,res,next)=>{const match=/^(cmaps|standard_fonts|wasm)\/([\w.-]+)$/.exec((req.url??'').replace(/^\//,''));if(!match)return next();const file=path.join(pdfRoot,match[1],match[2]);if(!fs.existsSync(file)||!fs.statSync(file).isFile())return next();res.setHeader('Content-Type',file.endsWith('.wasm')?'application/wasm':'application/octet-stream');fs.createReadStream(file).pipe(res);});},
  }],

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
