# 进度状态（唯一权威）

> **开工前先读本文件；每完成一件事就更新本文件。**
> 本文件只记录「进度」。计划与任务清单见 [PLAN.md](./PLAN.md)，设计与决策见 [DESIGN.md](./DESIGN.md)。

**最后更新**：2026-09-08 (Asia/Shanghai) · **v0.1.5：修节点面板定位两 bug（ADR-041）**；此前 Release v0.1.0/v0.1.1 已发布、M7-1 全平台打包完成

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
| **阅读模式=单页/双页** | 均连续；单页铺满整宽(不居中收窄)，双页=真 PDF 双页连续(ADR-031) |
| **双页不截断公式** | 块不拆分,装不下整块换页留白;目录可收起 |
| **下标误判修复** | _TS_/snake_case 不再当公式标红，x_1/a_{ij} 仍渲染 |
| **双页放大不溢出+可调页面大小** | 显示宽==测量宽;默认按宽铺满,页面大小可调,间距收紧(ADR-032) |
| **M5 AI 地基**（provider/aiSettings/boardContext + 单测） | OpenAI 兼容请求构造 + SSE 解析 + outline 上下文；typecheck/126 测试/secrets 净 |
| **M5-1/M5-2 AI 对话窗 + 流式** | Rust ai_chat_stream(reqwest 流式)+ai_cancel;FAB+独立窗(?ai=1)+浮层回退;回答复用 M4 渲染(ADR-034) |
| **M5-3 白板工具调用** | AI 可主动查白板结构/节点文档/检索(agentic function calling,4 工具);"正在查阅"提示(ADR-035) |
| **M5-6 节点引用回链** | AI 回答里 [[node:id]] 显示为节点标题胶囊(不再乱码),点击跳白板并居中闪烁高亮(ADR-036) |
| **修 AI 回答表格/加粗乱码（真落盘）** | AiChat guessMath 真正置 false(此前一次提交因 /tmp 被 rf 覆盖未生效,已回读线上第 80 行确认=false);AI 输出规范 md 不需猜公式,表格/加粗/引用胶囊恢复正常(ADR-037) |
| **M5 对话历史持久化** | 每块白板对话长期存 `<root>/<project>/<board>/chats.json`(退出不丢),Rust chats_read/chats_write + api.chatsRead/chatsWrite + chatStore.ts(多会话结构);AiChat 打开自动续接最近会话,＋新对话/🕘历史面板切换;浏览器回退 localStorage;chatStore.test.ts 8 测试(ADR-038) |
| **M5-4 上下文预算/历史压缩** | budget.ts:token 估算+单条超长硬截断+按预算保留最新历史,挤出的最旧历史压成一条 system 摘要保持连贯;system 提示词与本轮问题恒保留;设置加"上下文预算"滑杆(2k-32k);budget.test.ts 11 测试(ADR-039) |
| **M5-7 API Key 加密+隐私** | 密钥不明文落盘:Tauri 走 OS 原生凭据库(Keychain/凭据管理器/Secret Service,keyring crate),localStorage 只存非敏感字段;secret_set/get/delete/has 命令+api;aiSettings 异步载入/保存密钥,旧明文自动迁移清除;浏览器回退 localStorage;隐私开关 shareBoard 沿用;cargo check✓/aiSettings.test 扩至 6 例(ADR-040) |
| **O-4 系统打开 PDF** | open_doc_external(Win/mac/linux)+api.docOpenExternal |
| **目录/块级公式渲染** | TOC 标题公式(TocItem.html)与多行 $$ 块修复(不再变红) |
| **文档预览卡放大** | 去掉节点标题的另建预览框；关联文档预览卡单列、字号加大到可读 |
| **阅读窗自绘标题栏** | 阅读窗去系统装饰，自绘可拖拽标题栏(Win三键/mac红绿灯位) |
| **设置滚动修复** | 头部固定不随滚动消失 + 圆角自定义滚动条 |
| **阅读体验** | 连续滚动/双页(无缝+页码+翻页)、全屏 |
| **修节点面板定位两 bug（ADR-041，发 v0.1.5）** | 用户报：① 展开「项目/白板」侧栏时节点面板被挤出可视区；② 按住面板标题栏起拖时面板突然下移一截。根因是**坐标系串味**——面板是 `.board-canvas` 内的 `position:absolute`，却把 `getBoundingClientRect()` 的**视口坐标**写进 `style.left/top`：侧栏展开使画布左边界右移 224/448px，面板随容器被推出屏幕；画布上方还有 44px 标题栏，每次起拖重新测量都会再叠加一次偏移，于是每拖一次下移 44px。改：浮动态 `.node-panel.is-floating` 用 `position:fixed`，测量与写入口径统一为视口；首次测量即 `clamp`；监听 `resize` 重新夹紧；`.np-head` 提层盖住顶边 `np-resize-n` 拉伸条（防误触发「从顶边缩小」）；四角手柄 `z-index:7` 保留拉伸；新增双击标题栏复位。验证：tsc EXIT=0 / vitest **221 passed(15 files)** / vite build ✓ / **cargo check ✓(lumen v0.1.5)** / check:secrets 净。**待用户实机验收** |
| **发 v0.1.5（Release 已 Publish）** | 提交 `5cf4769`(fix) + `59cc847`(chore: bump 0.1.5)；tag `v0.1.5` 推送触发 Release 工作流（run `34237288809`：macOS 4m59s ✓ / Windows 6m52s ✓）；产物 dmg 5.32MB / zip 5.24MB / NSIS 4.04MB / MSI 5.34MB / app.tar.gz 5.24MB；**Release 已 Publish 并置为 Latest** → https://github.com/theincrediblewwz/lumen/releases/tag/v0.1.5 。同批 CI(`34237267520`) 双 job 全绿：Rust 单测 1m5s ✓ / 类型检查·密钥扫描 23s ✓ |

## 三、进行中

### M6 打磨阶段（P1 全清，P2 进行）
- **M6-1~M6-4 完成**：三主题统一 / 动效对齐 DESIGN §4.3 / prefers-reduced-motion / 树状自动布局。
- **M6-5** PDF 点击 = 调系统默认程序打开（决策⑳），视为完成。
- **M6-6 全局搜索 完成并推送（`82e90fe`）**：Rust `search_all` 跨白板全文检索 + 前端 `GlobalSearch`（Ctrl/Cmd+K 弹窗、防抖 live search、键盘导航、命中高亮、点击跳转白板高亮）。
- **M6-7 导出 md/HTML/PNG/SVG 完成并推送（`c2a4dd4`）**：
  - 纯函数 `src/canvas/boardExport.ts`（`buildForest` 图→森林；`exportMarkdown` 保留父子层级；`exportHtml` 独立内联样式；`exportSvg` 按坐标画卡片+连线+箭头）+ 11 测试。
  - Rust `export_text` / `export_binary`（写入白板 `exports/` 目录，`safe_export_name` 限 .md/.html/.svg/.png，自写 base64 解码无新依赖）。
  - 前端 `api.exportText/exportBinary` + App 应用菜单「导出 · md/HTML/SVG/PNG」；PNG 由 SVG 经 Image→canvas→toDataURL 栅格化（2x）。
- **M6-8 快照与恢复 完成（本轮，待提交）**：
  - Rust `storage.rs` 加快照层：`snapshots_dir`（白板 `.snapshots/`）、`snapshot_board`（打开前存 `board.<ts>.json`，与最近一份去重、保留最近 20 份 `prune_snapshots`）、`list_snapshots`（倒序+节点/连线数+字节数+auto_backup 标记）、`restore_snapshot`（恢复前先存「恢复前保险」快照再覆盖，纠正归属）、`delete_snapshot`、`safe_snapshot_name` 防穿越；+ Rust 单测 `snapshot_create_list_restore_and_prune`（cargo test **12 passed**）。
  - commands.rs 加 `snapshot_list/create/restore/delete`，lib.rs 注册。
  - 前端 `api.snapshotList/Create/Restore/Delete` + `SnapshotMeta` 类型；新建 `src/components/SnapshotPanel.tsx`（列出历史版本、存快照、恢复、删除，「恢复前保险」徽标）；App 打开白板时自动 `snapshotCreate`、应用菜单加「快照与恢复…」、渲染面板；styles.css 加 `.snap-*` 样式（复用 `.gs-overlay/.gs-panel`）。
  - 验证：tsc EXIT=0、vitest **198 passed(14 files)**、vite build EXIT=0、cargo test **12 passed**。
- **M6-9 快捷键与可访问性 完成（本轮，待提交）**：
  - 纯逻辑 `src/canvas/shortcuts.ts`：平台感知 combo 体系（`mod`=⌘/Ctrl）、`parseCombo/matchCombo/matchShortcut/formatCombo/formatShortcut`、`isEditableTarget`、`isMac`（可注入 platform）、`SHORTCUTS` 定义表（全局/视图/画布/节点四组）+ `shortcuts.test.ts` **23 passed**。
  - 新建 `src/components/ShortcutsHelp.tsx`：Shift+/（?）打开的帮助面板，按组列出全部快捷键，平台感知显示 ⌘/Ctrl（`role=dialog aria-modal`，双栏布局）。
  - App.tsx：全局 keydown 改用 shortcuts 模块（全屏 F11 / 搜索 mod+K / 帮助 ? / Esc 退全屏），加 `helpOpen` state、菜单「快捷键帮助 ?」、渲染 `<ShortcutsHelp>`。
  - BoardCanvas.tsx：keydown 集中匹配，新增 视图缩放（mod+= / mod+- 以视口中心为锚）、mod+0 重置 100%、Shift+1 适配全部内容（`fitAll`）、N 视图中心新建节点、方向键微移选中节点（Shift 步长 20/普通 2，进历史可撤销）、Esc 取消选中；工具栏加 `role=toolbar`+aria-label、缩放（−/百分比/＋）与适配按钮。
  - styles.css：`.tb-zoom`（等宽百分比）与 `.sc-*` 帮助面板样式（主题感知、窄屏单栏）。
  - 验证：tsc EXIT=0、vitest **221 passed(15 files)**、vite build EXIT=0。
- **M6 打磨阶段全部完成**（M6-1~M6-9）。
- **M7-3 用户文档 完成并推送（`2d9e371`）**：`docs/USER_GUIDE.md` + `README.md` 全量刷新。
- **M7-6 CI + M7-1 打包配置 + M7-4 验收清单 + M7-5 性能基线 完成（本轮，待提交）**：
  - **M7-6**：`.github/workflows/ci.yml` 补 `npm test` + `npm run build` 步骤，新增 `rust-test` job（Linux 装 webkit2gtk/gtk 依赖 + `cargo test`）。release.yml 已存在（tag `v*` 触发 mac arm64 + win 构建，tauri-action）。
  - **M7-1 打包配置**：`src-tauri/tauri.conf.json` bundle 段补全 icon 列表、publisher、short/longDescription、copyright、NSIS `installMode=currentUser`、macOS `minimumSystemVersion=11.0`；`cargo check` EXIT=0 通过。图标齐全（icons/ 下 icns/ico/png 全在）。
  - **M7-4**：新建 `docs/ACCEPTANCE.md`——DESIGN §3 FR-1~9 逐条映射状态（✅自动化覆盖 / 🟩需实机 / ⏳待实机 / ➖本期不做），汇总自动化覆盖与需实机项。
  - **M7-5**：新建 `docs/PERF.md`——前端产物体积已实测（dist ~1.79MB，主 JS ~650KB/CSS ~90KB/KaTeX 字体 ~0.5MB）；画布 FPS、阅读首屏、安装包体积、启动时间列方法+目标待实机回填。
- **M7-1 Windows 打包 成功（本轮，本机实测）**：`npm run tauri:build` 通过——release 编译约 1m45s，产出 **NSIS `Lumen_0.1.0_x64-setup.exe` 4.26 MB**（<10MB 目标达标）+ MSI 5.65 MB + lumen.exe 14.0 MB；体积已回填 `docs/PERF.md`。产物在 `src-tauri/target/release/bundle/`（target/ 已 gitignore，不入库）。顺手清理了仓库里遗留的未跟踪临时脚本（`_acl*.js`、`gen_sample.mjs`）。
- **M7-1 全平台打包完成 + Release `v0.1.0` 已发布（本轮）**：GitHub Actions release 工作流 `34195641889` SUCCESS（win + mac aarch64 双 job 全绿），draft release 已由用户手动 Publish。产物体积实测（已回填 `docs/PERF.md`）：
  - macOS arm64 `Lumen_0.1.0_aarch64.dmg` **5.38 MB**（<15MB 达标）+ `Lumen_aarch64.app.tar.gz` 5.30 MB（更新包）；
  - Windows `Lumen_0.1.0_x64-setup.exe`（NSIS）**4.04 MB** + `Lumen_0.1.0_x64_en-US.msi` **5.34 MB**（CI 构建，与本机略有差异，均达标）。
  - 一期 ad-hoc 未签名，macOS 首次打开需右键「打开」绕过 Gatekeeper。**M7-1 🟢 完成。**
- **新功能：OS 文件拖放到节点导入（`6007aa5`，本轮）**：从桌面/资源管理器拖 `.md`/`.markdown` 到白板某节点上，松手即 `docImport` 到该白板 `docs/` 并 `attachDocs` 挂到该节点（按 path 去重）。用 Tauri v2 原生 `onDragDropEvent`（拿真实绝对路径 + 物理坐标）→ dpr 换算 → `toWorld` → `boxContains` 命中；拖动时高亮目标节点（`.is-drop-target`）+ 底部「松开嵌入」提示条，导入中显示「正在导入文档…」；非 md 过滤提示。改 `BoardCanvas.tsx`/`NodeCard.tsx`/`styles.css`，`typecheck` EXIT=0，sess-11 HMR 生效，**待用户实机验收落点精度**。
- **M7 剩余**：M7-2 自动更新(P2，未做)；ACCEPTANCE/PERF 里标 ⏳ 的实机走查项（重启一致性、FPS 压测、阅读首屏、IME、AI 实调、启动计时）。
- 应用以后台会话 `sess-11` 运行中。

### M5（已完成，等实机验收）
- **M5 AI 对话：M5-1~M5-7 全部完成并推送**。当前等用户实机验收。
- 应用以后台会话 `sess-11`（`powershell -NoProfile -Command "npm run tauri:dev"`）运行中，`lumen.exe` 在用户桌面（此前会话因 /tmp 脚本跨会话清空 + 软件被用户关闭而中断，已重建 MCP 客户端并重启）。
- **等用户实机验收 M5**：
  - M5-7 密钥加密：设置里填 Key 保存 → 重开应用不用重填即可对话；`chats.json`/应用配置中不含明文 Key。
  - M5-4 上下文预算：调低「上下文预算」滑杆后连续多轮长对话，不报超长错且 AI 记得早前内容。
  - 复验：表格/加粗正常渲染、🕘历史面板切换会话、＋新对话、[[node]] 引用胶囊点击跳转高亮。
- **早期里程碑仍挂验收（非阻塞）**：M2-2/2-3 画布手感、M3 连线交互、外壳配色。


## 四、等待用户执行

| 事项 | 命令 | 说明 |
| --- | --- | --- |
| （可选）实机验收 M1 | 应用若仍在运行，直接操作：选目录 → 建项目 → 建白板 | 有问题告诉我，我来改 |
| （可选）本地跑单测 | `npm test` | 验证 CanvasEngine 换算内核（30 用例） |
| **实机验收 v0.1.5 面板定位** | 开白板 → 点节点出面板 → 展开/收起侧栏，面板应纹丝不动 → 拖标题栏，起拖不再下跳 → 双击标题栏可复位 | 装 v0.1.5 或 `npm run tauri:dev` |

> 注：推送等我已能自行完成（凭据已缓存，且走 ghproxy 镜像），不再需要用户代劳。

## 五、下一步（接下来我做的）

**M5 · AI 对话已全部完成**（决策：OpenAI 兼容优先 / PDF 调系统程序）。分解（全 ✅）：
1. ✅ M5 地基：Provider 纯逻辑层（OpenAI 兼容请求体 + SSE 流解析，单测）+ AI 设置持久化 + Rust `open_external`（O-4）
2. ✅ M5-1 悬浮 FAB + 独立 AI 对话窗口（绑定当前白板）
3. ✅ M5-2 网络传输走 Rust 命令 `ai_chat_stream`（reqwest 流式 + 事件回传，守"前端零网络"边界）+ 可中断
4. ✅ M5-3 白板工具：read_board_outline / list_nodes / read_node_doc / search_board
5. ✅ M5-4 token 预算 + 超长截断 + 最旧历史压缩（budget.ts，11 测试）
6. ✅ M5-5 回答渲染复用 M4 管线（含修 guessMath 乱码）；M5-6 引用回链 [[node:xx]]；M5-7 Key 加密(OS 凭据库 keyring)+隐私开关
7. ✅ 附加：对话历史长期持久化到白板 chats.json（退出不丢，多会话）

**下一步**：M5 全部完成，待用户实机验收后可收尾进入下一里程碑（M6）。验收基线：tsc EXIT=0 / vitest 177 passed(12) / cargo check ✓ / vite build ✓ / secrets 净。


## 六、阻塞项

- 无。**但 M2-2 起涉及视觉与交互，我在无 GUI 的沙箱里无法看效果**，需要你跑 `npm run tauri:dev` 后反馈（截图或描述）。M2-1 为纯逻辑，已用单测证明。

## 七、待定问题

| ID | 问题 | 何时需要定 |
| --- | --- | --- |
| ~~O-5~~ | ~~结构自由度~~ | ✅ **已定：图存树显**——允许一个节点有多个父节点（交叉引用），数据结构用图，默认呈现为树 |
| ~~O-3~~ | ~~AI 供应商与鉴权方式~~ | ✅ **已定：OpenAI 兼容优先**（baseURL + API Key，可接官方或任意兼容网关）；Provider 层预留 Anthropic/Ollama 扩展位 |
| ~~O-4~~ | ~~「点击 PDF」的确切语义~~ | ✅ **已定：调系统默认程序打开**（不在应用内嵌 pdf.js；经 Rust `open_external` 命令） |
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
| **tauri-action 偶尔会产出「untagged」Release** | v0.1.5 那次 Release 工作流双 job 全绿，但产出的 release 没挂到 tag 上：`html_url` 是 `/releases/tag/untagged-5a81498f…`，`GET /releases/tags/v0.1.5` 返回 404（v0.1.0~v0.1.4 都正常），PATCH `tag_name` 修不回来。解法：`gh api -X DELETE .../releases/<id>` 删掉悬空 release，再用 `gh release create v0.1.5 <产物...> --title ... --notes-file ...` 在已有 tag 上重建并重新上传；产物可先 `gh api .../releases/assets/<id> -H "Accept: application/octet-stream"` 下载回来（**务必按 size 校验**，网络抖动会静默截断）。**发版后必查**：`gh release view <tag>` 的 url 必须是 `/releases/tag/<tag>` |
| **本机 `gh` 认不出仓库（git remote 是 ghproxy 镜像）** | remote 指向 `https://ghproxy.net/https://github.com/...`，gh 报「none of the git remotes configured for this repository point to a known GitHub host」。应对：除 `gh api` 外的子命令都加 `gh --repo theincrediblewwz/lumen ...`；**`gh api` 不支持 `--repo`**，必须写完整 URL：`gh api https://api.github.com/repos/theincrediblewwz/lumen/...` |
| **浮动面板的坐标系必须和定位方式对齐** | `getBoundingClientRect()` 给的是**视口坐标**，`position:absolute` 的 `left/top` 却是**容器坐标**。给画布内的浮动面板写坐标前，要么改 `position:fixed`（推荐），要么手动减去容器 rect。混用的症状：容器尺寸一变元素就漂移，且每次重新测量都会再叠加一次偏移（表现为「每次拖动都往下跳一截」）。改 `fixed` 前务必确认祖先链上没有 transform/filter/backdrop-filter/contain——否则 fixed 会被该祖先重新锚定，bug 原样复发（ADR-041） |























