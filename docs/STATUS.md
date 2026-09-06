# 进度状态（唯一权威）

> **开工前先读本文件；每完成一件事就更新本文件。**
> 本文件只记录「进度」。计划与任务清单见 [PLAN.md](./PLAN.md)，设计与决策见 [DESIGN.md](./DESIGN.md)。

**最后更新**：2026-09-06 22:30（Asia/Shanghai）

---

## 一、已定案的决策（不再重复询问）

| 项 | 决定 |
| --- | --- |
| 项目命名 | **脉络（Lumen）**，包名 `com.lumen.app`，仓库 `theincrediblewwz/lumen` |
| 技术栈 | **Tauri 2.x + React 18 + TypeScript + Vite**；主目标平台 macOS(arm64)，Windows 次之 |
| 仓库形态 | **公开**仓库（Actions 分钟数不限） |
| 构建节奏 | 按里程碑构建（M2/M4/M5/M7，约 4–6 次）；push 与 PR 只跑 Linux 检查 |
| 签名公证 | 一期不做，出 ad-hoc 构建（自用 + 极小范围分享） |
| 密钥管理 | 私密文件放 `.local/`（已 gitignore）+ `scripts/check_secrets.js` 扫描兜底 |
| 文件读写 | 全部走 Rust 侧 `std::fs`，**不暴露 fs 插件给前端**（权限面最小） |
| 节点结构 | **图存树显**：允许一个节点有多个父节点（交叉引用）；数据结构用图，默认呈现为树 |
| 单元测试 | **Vitest**（DESIGN §8 已定）；纯函数内核跑在 Node 环境，测试文件与源码同目录 `*.test.ts` |
| 坐标系约定 | 容器 transform = `translate3d(x,y,0) scale(zoom)`；`screen = world*zoom + (x,y)`。screen 指相对**画布容器左上角**，client 坐标须先减去容器 rect |
| 标题栏策略 | **native_mac**：macOS 用 `titleBarStyle=Overlay` 保留系统红绿灯 + 内容延伸；Windows/Linux `decorations=false` 自绘右侧窗口按钮。路径与「更改目录」收进标题栏菜单 |

## 二、已完成

| 事项 | 验证情况 |
| --- | --- |
| 设计文档 v0.2（含 §11 跨平台与发布策略、ADR-001~010） | — |
| 进度规划（M0–M7、任务看板、9 项风险） | — |
| MCP 环境：白名单加 `cargo`/`rustc`/`rustup`，超时 900s | `cargo 1.95.0` / `rustc 1.95.0` 实测通过 |
| 密钥防线：`.local/` + `.gitignore` + 扫描脚本 | **负向测试通过**：注入假 `sk-` 密钥被正确拦截（退出码 1） |
| 仓库骨架（前端 + `src-tauri` + CI + 文档） | `npm install` 成功；`npm run build` 成功 |
| **M1-1/M1-2** Tauri + Vite + React + TS 工程；命令层与 capability 最小权限 | `cargo check` 通过（Tauri 2.11.5 / dialog 2.7.3） |
| **M1-3** BoardRepository：数据模型、目录布局、原子写、id 路径穿越校验 | **6 项 Rust 单测全部通过** |
| **M1-4** 设置：存储根目录选择（系统目录选择器）+ 配置持久化 | 代码完成，待 GUI 验收 |
| **M1-5** 项目 / 白板 CRUD 与最小界面 | 代码完成，待 GUI 验收 |
| 首次推送至 GitHub | CI `#1` 状态 `completed / success` |
| **应用首次成功启动** | Vite 监听 5173 正常；Rust 编译通过；`lumen.exe` 已运行，无报错 |
| **测试基建：Vitest 接入** | `npm test` 跑通；`vitest.config.ts`（node 环境，`src/**/*.test.ts`）+ `test`/`test:watch` 脚本 |
| **M2-1** `CanvasEngine`：视口平移/缩放 + 屏幕↔世界坐标换算（纯函数内核 + 薄类封装） | **30 项 Vitest 单测全部通过**；`npm run typecheck` 通过；`check:secrets` 通过 |
| **UI 改版**：右键菜单替代底部固定表单 + 自定义现代化标题栏（native_mac） | `typecheck`/`npm test`(30)/`npm run build`/`cargo check` 全通过 |
| **UI 优化**：字体栈/字号/间距升级、屏蔽 WebView 原生右键菜单、白板主区改纯白 + 外壳灰层次 | `typecheck` 通过；用户实机确认（HMR 已热更） |
| **M2-2/M2-3** 白板画布 v1：节点卡片渲染 + 滚轮缩放/空白平移 + 右键新建/拖拽移动/双击编辑 + 防抖落盘 | `typecheck`/`npm test`(30)/`check:secrets` 通过；后台 sess-3 运行无报错，待用户实机验收手感 |
| **侧边栏收起 + 全屏模式** | 项目/白板栏各自可收起为竖条；F11/菜单进全屏、Esc/按钮退出（Tauri setFullscreen）。`typecheck` 通过，dev 已热更 |
| **M2-8** 命令栈：撤销/重做（新建/删除/改标题/拖拽移动） | 纯函数 history.ts + **9 项单测**（合计 39 passed）；Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y + 右键菜单；`build` 通过 |
| **UI 修整**：侧栏统一开关 + 画布工具栏 | 标题栏「脉络」旁三横线一键收起/展开整条侧栏（移除两条竖条 rail）；画布左上角悬浮工具栏 **＋新建节点 / 撤销 / 重做**，双击空白亦可新建 |
| **画布交互修复 + 热力光晕**：右键/删除可靠化、节点缩小发光、项目二次点击取消选中 | 右键菜单改 Portal 到 body 并 stopPropagation（修复点菜单被画布 pointer-capture 吞掉导致「右键新建/删除」时灵时不灵）；移除左上角「＋新建节点」按钮（回归右键/双击空白新建），仅保留撤销/重做；节点 ::before 热力光晕随 zoom 缩小而增强；再次点击已选项目=取消选中并收起白板栏 |
| **项目/白板重命名**（rename_project / rename_board 命令 + 存储层） | **Rust 单测 8 项全过**（新增 rename 2 项）；同步改 index/project/board.json |

## 三、进行中

- 白板画布 v1（M2-2 节点 DOM 层 + M2-3 新建/编辑/移动）已接入主界面，代码级验证全过。
- **等用户实机验收**：新建/拖拽/双击编辑/缩放平移的手感，以及自动落盘后重开白板节点是否还在。
- 应用以后台会话 `sess-3`（`npm run tauri:dev`）运行中，窗口在用户桌面。


## 四、等待用户执行

| 事项 | 命令 | 说明 |
| --- | --- | --- |
| （可选）实机验收 M1 | 应用若仍在运行，直接操作：选目录 → 建项目 → 建白板 | 有问题告诉我，我来改 |
| （可选）本地跑单测 | `npm test` | 验证 CanvasEngine 换算内核（30 用例） |

> 注：推送等我已能自行完成（凭据已缓存，且走 ghproxy 镜像），不再需要用户代劳。

## 五、下一步（接下来我做的）

1. **等用户验收画布 v1** 手感与持久化
3. **M3** 连线层（EdgeLayer）：SVG 贝塞尔连线 + 箭头 + 锚点吸附
4. 节点悬停简介 Tooltip / 节点内容面板（NodePanel）


## 六、阻塞项

- 无。**但 M2-2 起涉及视觉与交互，我在无 GUI 的沙箱里无法看效果**，需要你跑 `npm run tauri:dev` 后反馈（截图或描述）。M2-1 为纯逻辑，已用单测证明。

## 七、待定问题

| ID | 问题 | 何时需要定 |
| --- | --- | --- |
| ~~O-5~~ | ~~结构自由度~~ | ✅ **已定：图存树显**——允许一个节点有多个父节点（交叉引用），数据结构用图，默认呈现为树 |
| O-3 | AI 供应商与鉴权方式 | M5 前 |
| O-4 | 「点击 PDF」的确切语义 | M4 前 |
| O-6 | 是否支持直接导入 ChatGPT 导出 JSON | M6 后 |

## 八、踩过的坑（避免重犯）

| 坑 | 说明 |
| --- | --- |
| **不要替用户判断「可能会失败」** | `git push` 我原以为会卡在浏览器鉴权而交给了用户，实际凭据已缓存、直接就成功了。**先自己试，失败了再交给人** |
| **Vite 端口 EACCES** | Tauri 模板默认的 1420/1421 在部分 Windows 上被 Hyper-V/WSL 动态端口保留段排除，Node 报 `EACCES`（不是 `EADDRINUSE`，别按「端口被占用」去查）。已改用 5173/5174 |
| Tauri 构建脚本需要图标 | 即使只是 `cargo check`，build script 也要求 `src-tauri/icons/icon.ico` 存在。须先 `npm run tauri -- icon <源图>` 生成；源图可用 `node scripts/make_icon.js` 生成 |
| `"type": "module"` | 仓库内 `.js` 脚本必须写 ESM；用 `require` 会静默失败——曾因此把临时文件误提交 |
| TS6310 | `composite` 项目不可设 `noEmit`；已改为单一 tsconfig + `@types/node` |
| MCP 无法直接 spawn npm | 本机 npm 是 `npm.ps1`，须经 `powershell -File` 包装；MCP 里用 `powershell -NoProfile -Command npm ...` 可跑通 |
| MCP 配置改动不生效 | 只换隧道不重启 `server.mjs` 时，`config.json` 改动不会重新读取 |
| MCP `apply_patch` 对 JSON 上下文不稳 | 给 `package.json` 打小补丁时报「patched」却未生效（同尺寸）；改用 `write_file` 全量覆盖更可靠 |
| **在 Windows 上跑出 GUI 不代表平台错了** | Tauri 用系统 WebView（Win=WebView2 / mac=WKWebView），同一套 React 代码在开发机（本机是 Windows，故产物为 `lumen.exe`）即可调试；「主目标 macOS」指最终发布用 mac 构建。macOS 的 `.app`/`.dmg` 必须在 mac 或 CI mac runner 上 `tauri build` |
| **自定义标题栏控件必须退出拖拽区** | 整条 titlebar 设 `-webkit-app-region: drag` 后，内部按钮要加 `no-drag`，否则点击被窗口拖拽吞掉 |

