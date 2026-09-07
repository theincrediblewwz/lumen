# 进度状态（唯一权威）

> **开工前先读本文件；每完成一件事就更新本文件。**
> 本文件只记录「进度」。计划与任务清单见 [PLAN.md](./PLAN.md)，设计与决策见 [DESIGN.md](./DESIGN.md)。

**最后更新**：2026-09-07 16:35 (Asia/Shanghai)

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
| **UI 视觉大改版**：液态玻璃主题 + 节点重设计 + Markdown 气泡卡 + 全局动画 | 新增 settings.ts(主题/玻璃通透度/模糊/动画，持久化)+SettingsPanel(菜单「设置…」进入)； 全应用 .glass-surface 毛玻璃(跨引擎一致，ADR-015)；节点改为「概括标题+完整问题」自适应高度(修复长标题截尾)； 点击节点弹 NodeBubble 玻璃气泡卡看完整问题+Markdown 文档列表；侧栏收起/节点创建/气泡/面板均加动画。build+test(39) 通过 |
| 玻璃可见化 + 动画补全精修 | 修复玻璃看不出效果：开玻璃时给整窗铺主题化环境光晕背景(--ambient-*)+画布对浮层微透，让 backdrop-filter 有内容可折射；侧栏改为常挂载 width/opacity 过渡(收起也有动画、更丝滑)；补全动画：白板栏滑入、列表项 hover 位移、按钮按压、三横线旋转、全屏/占位淡入、设置分区错落入场；结论：callstack/liquid-glass 是 React Native(原生 iOS Swift)库，本 Tauri/DOM 项目无法使用。build+test(39) 通过 |
| **项目/白板重命名**（rename_project / rename_board 命令 + 存储层） | **Rust 单测 8 项全过**（新增 rename 2 项）；同步改 index/project/board.json |
| **原生液态玻璃**（window-vibrancy，ADR-017/018） | Mac=Liquid Glass(macOS26+)/vibrancy fallback、Win=Mica/Acrylic、CSS native-glass、设置 原生/网页/关闭 三档；Windows 实机编译+启动无 panic（`700e5f2`）；Mac 观感待 Mac 上验 |
| **玻璃观感修正**：内容区实色化、外壳主题色半透明（`835382a`） | 修"整片米黄+焦点变色"：board-canvas 改回实色不透材质，titlebar/sidebar 主题色半透明+轻 backdrop-filter，浮层/node-card 提高不透明度 |
| **平台策略：Windows/Linux 纯实色、原生玻璃仅 Mac**（ADR-019，`solid_win`） | Cargo window-vibrancy 依赖只留 macOS target 并给 tauri 加 macos-private-api feature；`apply_native_material` 仅 `#[cfg(target_os="macos")]`；前端 `applySettings(s,platform)` 非 mac 时 native 退化 off、设置面板"原生"按钮禁用标"·仅Mac"。`cargo check`/`npm run build`/`check:secrets` 全过；Windows 实机 tauri:dev 启动无 panic（sess-5） |
| **M3 连线层 EdgeLayer**：贝塞尔连线+箭头+锚点吸附+有向无向+标签+级联删除+持久化+撤销 | 新增 `src/canvas/geometry.ts` 纯函数(borderPoint/edgeGeometry/boxContains) + **12 单测**(合计 **51 passed**)；BoardCanvas 历史栈改 Graph{nodes,edges}、锚点拖拽建连线、SVG 边层随世界层 transform、端点吸附边框、Delete 删选中连线/节点、右键切有向/无向+标签内联编辑、删节点级联清边；App onCanvasChange 落盘 edges。`typecheck`/`npm test`(51)/`npm run build`(47模块)/`check:secrets` 全过；dev sess-5 HMR 生效 |
| **外壳配色刷新**（ADR-021）：侧栏/顶栏更清新明亮 | `--bg-chrome` 冷灰 #f6f7f9→近白微青绿 #fbfdfc、`--bg-hover` 改强调色淡染、边框带绿浅色；三主题补 `--edge-color`/`--edge-label-bg` 连线配色。待用户看观感 |
| **修复 M3 编辑模式卡死三连 bug** | 编辑态无退出路径导致：锚点全灭/Delete 被拦/拖不出连线。改 showAnchors 为 `editingId!==n.id`、编辑区 onBlur 自动退出+保存、Esc 取消、加操作提示。typecheck/test(51)/build/check:secrets 全过 |
| **修复连线拉不出来** | 锚点拖拽改用 window 级监听 + graphRef，不再依赖会被卸载的锚点元素/指针捕获。typecheck/test(51)/build/secrets 全过 |
| **修复连线完全不可见（根因）** | 连线 SVG 原画在 0×0 世界层内，WebView2 不渲染零尺寸 SVG。改为铺满画布的全尺寸 SVG 覆盖层、屏幕坐标绘制、视口变化实时重算（ADR-022）。typecheck/test(51)/build/secrets 全过 |
| **连线锚点 4→1** | 四点拖出的线一样、冗余且误导，改为节点右侧单个连线手柄（实心墨绿+中心白点）。typecheck/test(51)/build/secrets 全过 |
| **连线样式设置**：曲线/直线/折线 | geometry.edgeGeometry 加 style 参数+5 单测(56 passed)、settings.edgeStyle 持久化、SettingsPanel 分段控件、切换即时重绘 |
| **修复曲线退化成直线** | 贝塞尔控制柄改为沿弦垂直方向弓出，任意摆位都有明显弧度 |
| **M2-6 悬停简介 Tooltip** | 悬停节点 400ms 浮出只读预览卡（标题+问题前 4 行+文档数） |
| **M2-7 节点内容面板 NodePanel** | 点击节点右侧停靠：编辑标题/问题、7 色标记、文档列表、二次确认删除；Esc 关闭 |
| **曲线弧形重画** | 单拱对称弧（拱顶抬起+二次转三次贝塞尔），更自然、拱高更收敛 |
| **精简右键菜单** | 节点右键去掉「编辑」（已由面板覆盖），右键即开面板、仅留「删除节点」 |
| **颜色标记联动** | 节点色驱动 选中框/outline/光晕/连线锚点 同色；左侧色条加粗 3→6px |
| **chrome 调清新明亮** | 侧栏/标题栏改薄荷白+顶部冷绿高光渐变，白板栏亮一档做纵深（仅 light，paper/dark 未动） |
| **M4 阅读内核（M4-1~8 全）** | markdown-it+KaTeX 引擎、公式两级保护、TOC 跳转、字号/主题/进度、编码探测、分批排版 |
| **M4 文档导入 + 独立阅读窗口** | NodePanel 导入/打开/移除 md；Tauri 独立窗口(reader-*) + 浏览器浮层回退 |
| **修复深色/纸感侧栏发白** | chrome-2/渐变变量泄漏到非浅色主题，已在 dark/paper 显式覆盖 |
| **文档预览方卡** | NodePanel 关联文档改缩略渲染方框（DocPreview），点开进阅读器 |
| **阅读器跟随主体主题+title** | 去掉阅读器独立主题，改用主体 token；窗口标题「X — 脉络 Lumen」(ADR-027) |
| **数学猜测渲染** | 设置开关；无分界符但明显是数学的片段自动识别渲染 |
| **公式定界符归一化** | \(…\)/\[…\] 自动转 $/$$，修复公式标红不渲染；猜测渲染默认开启(v2) |
| **已开阅读窗前置** | 再次点击文档时 unminimize+show+置顶+聚焦，把已开窗口抬到最前 |
| **PDF 式双页** | 左右两页铺满整屏、向下翻跨页(transform 切页)，无横向滚动 |
| **节点面板文档区独立滚动** | 标题/问题固定，关联文档区单独滚动，不再挤压文本框 |
| **双页=竖向分栏纸页** | 竖向滚动的一张张纸，中缝分左右两栏，左栏满→右栏→下一张(ADR-030) |
| **目录/块级公式渲染** | TOC 标题公式(TocItem.html)与多行 $$ 块修复(不再变红) |
| **文档预览卡放大** | 去掉节点标题的另建预览框；关联文档预览卡单列、字号加大到可读 |
| **阅读窗自绘标题栏** | 阅读窗去系统装饰，自绘可拖拽标题栏(Win三键/mac红绿灯位) |
| **设置滚动修复** | 头部固定不随滚动消失 + 圆角自定义滚动条 |
| **阅读体验** | 连续滚动/双页(无缝+页码+翻页)、全屏 |

## 三、进行中

- 白板画布 v1（M2-2 节点 DOM 层 + M2-3 新建/编辑/移动）已接入主界面，代码级验证全过。
- **等用户实机验收**：新建/拖拽/双击编辑/缩放平移的手感，以及自动落盘后重开白板节点是否还在。
- 应用以后台会话 `sess-5`（`npm run tauri:dev`）运行中，窗口在用户桌面（sess-3 因整页重载/Cargo 变更退出，已重启）。
- **等用户验收 M3 连线**：拖节点四周锚点到另一节点建连线、右键连线切有向/无向/加标签/删除、删节点连线是否级联清除、重开白板连线是否恢复。
- **等用户验收外壳新配色**：侧栏/顶栏是否够清新明亮。


## 四、等待用户执行

| 事项 | 命令 | 说明 |
| --- | --- | --- |
| （可选）实机验收 M1 | 应用若仍在运行，直接操作：选目录 → 建项目 → 建白板 | 有问题告诉我，我来改 |
| （可选）本地跑单测 | `npm test` | 验证 CanvasEngine 换算内核（30 用例） |

> 注：推送等我已能自行完成（凭据已缓存，且走 ghproxy 镜像），不再需要用户代劳。

## 五、下一步（接下来我做的）

1. **等用户验收画布 v1** 手感与持久化
3. **M5** AI 辅助（问题拆解 / 回答渲染复用 M4 管线）
4. 节点配色/连线标签的更多样式微调（按需）


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












