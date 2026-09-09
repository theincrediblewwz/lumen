# 脉络（Lumen）· 设计文档

> **项目名**：脉络（Lumen）
> **技术栈**：Tauri 2.x（Rust 后端 + 系统 WebView）+ React 18 + TypeScript + Vite
> **主目标平台**：macOS（Apple Silicon / arm64）；Windows 次之
> **文档版本**：v0.2（技术栈与命名已定稿）
> **日期**：2026-09-06
> **状态**：M0 已定稿，可进入 M1
> **关联文档**：[进度规划](./PLAN.md) · [README](../README.md) · 任务追踪 `.dsh/todos.json`

---

## 0. 修订记录

| 版本 | 日期 | 修订人 | 说明 |
| --- | --- | --- | --- |
| v0.1 | 2026-09-06 | Agent | 初版草案：概念模型、功能需求、架构、数据模型、里程碑 |

---

## 1. 愿景与问题定义

### 1.1 痛点

用 ChatGPT / Claude 做研究学习时，知识是**线性聊天流**，但思考是**树状分叉**的：

1. **找回困难**——想复用前面某个回答，只能在长长的对话流里反复滚动。
2. **导出即平铺**——把每轮回答导出成 Markdown 存文件夹后，信息变成一堆无结构的文件；为了能找到，只能把摘要硬塞进文件名。
3. **脉络丢失**——"这个问题是从哪个问题分叉出来的""当时为什么追问这一步"完全丢失，只留下一地树叶，看不到树。

### 1.2 产品定位

**一个本地优先（local-first）的极简白板，用于把 AI 辅助学习的过程结构化为"问题树"。**

- 每个**节点 = 一个你问过的问题**（圆角方框包住标题）
- 每条**连线 = 一次思维的延伸或分叉**（有向 = 追问 / 无向 = 相关）
- 每片**叶子 = 一次 GPT 导出的 Markdown 回答**
- 一整块**白板 = 一个研究主题的脉络**

### 1.3 一句话定义

> 脉络 = 无限白板画布 + 问题树 + 本地 Markdown 文档库 + 离线公式阅读器 + 白板感知的 AI 助手。

### 1.4 非目标（Non-goals，明确不做）

| 不做 | 理由 |
| --- | --- |
| 云端同步 / 多人协作 | 一期坚持本地优先，文件即数据；同步交给用户自己的网盘或 Git |
| 做通用思维导图工具（对标 XMind 全部能力） | 我们只服务"AI 问答沉淀"这一个场景，克制功能 |
| 自己做模型 / 训练 | AI 通过标准 API 接入，可换供应商 |
| 移动端 | 阅读器子集已有 Android 版（mdread），桌面端优先 |

---

## 2. 核心概念模型

### 2.1 四层结构

```
项目 Project  （一门学问 / 一个长期方向，例如「扩散模型」）
 └─ 白板 Board    （一个研究主题，例如「数学基础」）
     └─ 节点 Node     （一个你问过的问题，例如「什么是 ELBO？」）
         └─ 文档 Doc      （一次 GPT 导出的回答，.md；二期支持 .pdf）
```

**关键约束：一棵树的问题，一片叶子的回答。**
节点的**标题**就是当时问的问题，**简介**是对回答的一句话摘要，**内容**是原始回答全文。

### 2.2 术语表

| 术语 | 英文 | 定义 |
| --- | --- | --- |
| 项目 | Project | 顶层容器，包含多个白板 |
| 白板 | Board | 一块独立画布，对应一个研究主题，对应磁盘上一个文件夹 |
| 节点 | Node | 画布上的圆角方框，代表一个问题；含标题、简介、绑定的文档 |
| 连线 | Edge | 节点间的关系，有向（追问/派生）或无向（相关） |
| 文档 | Doc | 节点绑定的 Markdown / PDF 文件，物理存放在白板文件夹内 |
| 阅读窗口 | Reader Window | 独立于白板的文档阅读窗口，完整渲染 Markdown + 数学公式 |
| AI 窗口 | AI Window | 悬浮按钮展开的对话窗口，上下文默认绑定当前白板 |

### 2.3 关键用户故事

| ID | 用户故事 | 验收要点 |
| --- | --- | --- |
| US-1 | 新建项目「扩散模型」→ 新建白板「数学基础」→ 右键建节点「什么是 ELBO？」→ 导入 GPT 导出的 md | 4 步内完成，无需配置 |
| US-2 | 从「什么是 ELBO？」拖出有向连线到「为什么需要变分推断？」，形成追问链 | 连线带箭头，可删除，随节点移动 |
| US-3 | 悬停节点看简介；点击节点在新窗口全文阅读，所有 LaTeX 公式正确排版 | 公式不串味、不被 Markdown 语法破坏 |
| US-4 | 白板沉淀 20 个节点后，点悬浮按钮问「这块白板研究了什么问题？思路是怎样的？」 | AI 基于白板内容回答，并给出可点击的节点引用 |
| US-5 | 换台电脑，把存储目录指过去 | 全部项目、白板、节点、连线、文档完整恢复 |

---

## 3. 功能需求

> 优先级：P0 = MVP 必需，P1 = 重要，P2 = 锦上添花

### FR-1 项目与白板管理（P0）

- **FR-1.1** 首次启动引导用户选择**存储根目录**（可随时在设置中更改）。
- **FR-1.2** 项目列表：新建 / 重命名 / 删除项目。
- **FR-1.3** 白板列表：项目内新建 / 重命名 / 复制 / 删除白板。
- **FR-1.4** 白板切换保留各自视口（平移、缩放）状态。

**验收标准**：删除项目需二次确认并说明"文件将从磁盘移除/移入回收站"；重启后所有层级结构与视口状态一致。

### FR-2 白板画布（P0）

- **FR-2.1** 无限画布，铺满窗口，默认空白。
- **FR-2.2** 平移：拖拽空白 / 空格+拖拽 / 中键拖拽。
- **FR-2.3** 缩放：Ctrl+滚轮（**以光标位置为锚点**），缩放范围 20%–400%，支持"适应画布"一键归位。
- **FR-2.4** 框选：空白拖拽出选择框，Shift 加选。
- **FR-2.5** 网格：极淡点阵网格，缩放时平滑淡入淡出（不做强网格吸附，保持自由）。

**验收标准**：500 节点 / 2000 连线下，平移与缩放稳定 ≥55 FPS。

### FR-3 节点（P0）

- **FR-3.1** 右键画布空白处 → 新建节点（在右键位置生成）；双击空白同效。
- **FR-3.2** 节点视觉：**圆角方形边框**包裹标题文字，宽度随文本自适应（含最大宽度与换行）。
- **FR-3.3** 节点可命名（双击标题进入编辑，Enter 提交 / Esc 取消）。
- **FR-3.4** **悬停显示简介**：鼠标悬停 ~400ms 后浮出简介卡片（Markdown 纯文本 + 行内公式渲染）。
- **FR-3.5** **点击展示内容**：打开节点内容面板，列出绑定的文档，点击即在**独立阅读窗口**打开。
- **FR-3.6** 拖拽移动，支持多选批量移动；可选轻微吸附对齐（可关）。
- **FR-3.7** 右键节点菜单：重命名 / 编辑简介 / 添加文档 / 发起连线 / 复制 / 删除 / 标记颜色。

**验收标准**：从右键到节点可输入标题 ≤150ms；悬停卡片不遮挡节点本体；标题编辑支持中文输入法（IME）正常提交。

### FR-4 连线（P0）

- **FR-4.1** 从节点边缘锚点拖出 → 拖到目标节点释放，建立连线。
- **FR-4.2** 连线可设为**有向**（默认，带箭头，表示追问/派生）或**无向**（表示相关），可切换。
- **FR-4.3** 连线为平滑贝塞尔曲线，节点移动时实时跟随且不过度抖动。
- **FR-4.4** 连线可选标签（如"追问""反例""应用于"）。
- **FR-4.5** 选中连线后可删除；删除节点时其连线一并删除并提示。
- **FR-4.6** 层级辅助（P1）：提供"树状自动布局"一键整理按钮——**注意：仅整理位置，不改变数据结构**，因为实际结构允许错综复杂的网状分叉。

**验收标准**：连线端点吸附到节点边框而非中心；曲线不与节点矩形重叠穿模；1000 条连线拖动目标节点时无卡顿。

### FR-5 节点内容与文档导入（P0）

- **FR-5.1** 节点可绑定**一个或多个** Markdown 文档（一次追问可能有多轮回答）。
- **FR-5.2** 导入方式：**拖拽 .md 文件到画布/节点**（自动建节点并以首行标题命名）、右键"添加文档"选择文件、从剪贴板粘贴（P1）。
- **FR-5.3** 导入时文件**复制**进该白板文件夹（可配置为移动）；重名自动加后缀。
- **FR-5.4** 自动摘要（P1）：导入后可选调用 AI 生成节点简介；未提供 key 时留空由用户手填。
- **FR-5.5** 节点内容面板内可移除文档、调整顺序、重命名标题。
- **FR-5.6** PDF 支持（P1/P2）：节点可绑定 PDF，在阅读窗口内以 pdf.js 打开（离线内置）。

**验收标准**：拖入 3 个 md 文件 → 生成 3 个节点，文件确实落在 `<root>/<project>/<board>/docs/`；外部删除文件后，节点显示"文件缺失"且不崩。

### FR-6 独立阅读窗口（mdread PC 版子集）（P0）

> 这是已完成的 Android 应用 **mdread** 的桌面化移植，作为本软件的子功能。

- **FR-6.1** 点击文档 → 打开**独立于白板之外**的阅读窗口，可多开、可最小化，白板照常操作。
- **FR-6.2** 完整 Markdown 渲染，复用 mdread 渲染内核（见 §5.5）：
  - markdown-it 定制规则：**块级 / 行内公式两级保护**（解决 `$…$` 内 `_ * { } \\` 被 Markdown 吞掉、`=` `-` 独占行被当成 setext 标题的问题）
  - KaTeX 排版，行内 `$…$` 与块级 `$$…$$` 均正确
  - **分批排版**：先排当前视口，空闲帧排其余，长文档不阻塞滚动
- **FR-6.3** 树形目录侧栏（6 级标题），点击跳转到正文锚点并短暂高亮。
- **FR-6.4** 字号 A− / A+（60%–150%）。
- **FR-6.5** 三套主题：浅色 / 纸感 / 深色，与白板主题联动。
- **FR-6.6** 阅读进度记忆：重开同一文档回到上次位置（公式排版完成后二次校准，避免高度漂移）。
- **FR-6.7** 编码回退：UTF-8 / BOM 探测 / GB18030 回退（中文 GPT 导出件常见）。
- **FR-6.8** 全部资源**离线内置**（markdown-it、KaTeX、字体），不请求网络。

**验收标准**：移植 mdread 的 `scripts/check_offline.js`、`check_tocpage.js` 回归套件并在 Node 侧全绿；400KB 含数百公式的文档打开首屏 <500ms，滚动不掉帧。

### FR-7 AI 对话（P1，MVP 之后紧接）

- **FR-7.1** **悬浮按钮**（右下角 FAB）→ 展开独立 AI 对话窗口。
- **FR-7.2** 在某白板打开时，对话**默认以该白板为上下文**（该白板各节点的所有 Markdown）。
- **FR-7.3** 数据读取走**工具调用**，而非一次性全塞进上下文：
  - `read_board_outline()` → 返回树状结构 + 节点标题 + 简介（**总是先给**）
  - `read_node_doc(node_id, doc_index?)` → 按需读取某节点文档全文（超长分段 + 截断提示）
  - `search_board(query)` → 在白板内全文检索，返回命中片段
  - `list_nodes()` → 列节点清单
- **FR-7.4** 回答支持 **Markdown + KaTeX 渲染**（与阅读窗口共用渲染管线）。
- **FR-7.5** 流式输出，可中断；失败可重试。
- **FR-7.6** **引用回链**：回答中的 `[[node:xxx]]` 渲染为可点击引用，点击跳回白板并高亮、居中该节点。
- **FR-7.7** 模型供应商可配置：OpenAI 兼容（可填 baseURL）/ Anthropic / 本地 Ollama；API Key 用系统级加密存储（Electron `safeStorage`），不明文落盘、不进日志。
- **FR-7.8** 隐私开关：可禁用联网 AI（此时仅剩本地阅读与白板能力）。

**验收标准**：对含 20 节点 / 15 篇 md 的白板提问"研究脉络是什么"，回答需引用 ≥3 个真实节点；引用点击能正确跳转；拔掉网络时优雅报错而不是崩溃。

### FR-8 设置与存储（P0）

- **FR-8.1** 存储根目录选择 / 修改（修改后提供"迁移已有数据"选项）。
- **FR-8.2** 自动保存（debounce 1s）+ 窗口关闭前强制 flush。
- **FR-8.3** 崩溃安全：原子写入（临时文件 + rename）。
- **FR-8.4** 快照（P2）：每次打开白板前保留一份 `.snapshots/board.<ts>.json`，保留最近 N 份。
- **FR-8.5** 外部变更感知：监听白板目录，用户在外部编辑器改了 md，回到软件时提示刷新。

### FR-9 主题与动效（P0/P1）

- **FR-9.1** 三主题：浅色 / 纸感 / 深色（变量命名沿用 mdread 的 CSS 变量体系）。
- **FR-9.2** 尊重系统 `prefers-reduced-motion`：开启时降级为瞬时切换。
- **FR-9.3** 详见 §4 视觉与交互规范。

---

## 4. 视觉与交互设计规范

### 4.1 设计原则

1. **克制**：画布上只有节点和线。默认隐藏一切工具栏，工具栏在需要时浮现。
2. **内容优先**：节点标题即问题，字号与对比度保证"扫视可读"。
3. **动效服务于理解**：动画用来表达"它从哪来、到哪去"，不用来炫技。
4. **留白**：节点间距、画布边距、面板内边距遵循统一 4px 栅格。

### 4.2 设计 Token

| 类别 | Token | 值 |
| --- | --- | --- |
| 圆角 | `--radius-node` | 10px |
| 边框 | `--border-node` | 1px（选中 2px） |
| 阴影 | `--shadow-node` | `0 1px 2px rgba(0,0,0,.04), 0 4px 12px rgba(0,0,0,.04)` |
| 阴影（悬停） | `--shadow-node-hover` | `0 2px 4px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.08)` |
| 节点字号 | `--font-node` | 14px / 行高 1.45 |
| 画布背景 | `--bg-canvas` | 主题变量（浅 `#FBFBFA` / 纸感 `#F5F1E8` / 深 `#16171A`） |
| 节点底色 | `--bg-node` | 比画布亮一档 |
| 强调色 | `--accent` | 单一主色（待定，建议低饱和靛蓝或墨绿），**全应用只用这一个彩色** |

### 4.3 动效规范

| 场景 | 时长 | 缓动 | 表现 |
| --- | --- | --- | --- |
| 时长-瞬时 | 80ms | `cubic-bezier(.2,0,0,1)` | 颜色/边框变化 |
| 时长-快 | 140ms | 同上 | 悬停抬升、按下反馈 |
| 时长-标准 | 220ms | `cubic-bezier(.2,0,0,1)` | 面板滑入、菜单展开 |
| 时长-慢 | 360ms | `cubic-bezier(.2,0,0,1)` | 白板切换、树状自动布局归位 |
| 节点新建 | 180ms | 减速 | `scale .96→1` + `opacity 0→1` |
| 节点删除 | 140ms | 加速 | `scale →.96` + `opacity →0`，连线同步淡出 |
| 连线建立 | 300ms | 标准 | `stroke-dashoffset` 由起点画到终点 |
| 悬停简介 | 120ms | 快 | 卡片 `opacity + translateY(4px→0)`，**延迟 400ms 触发** |
| 平移/缩放 | 0ms | — | **直接跟随指针，禁止缓动**（加缓动会"发飘"） |
| 惯性滚动 | ~400ms | 减速 | 松开后按初速度衰减 |
| 内容面板 | 240ms | 标准 | 面板滑入，内容延迟 60ms 淡入 |
| 引用跳转 | 600ms | 慢 | 视口缓动居中目标节点 + 节点高亮脉冲 2 次 |

**原则**：位移类用减速曲线（进入感），消失类用加速曲线（干净利落）；任何动效不得超过 400ms（除跳转外）。

### 4.4 交互矩阵

| 操作 | 空白画布 | 节点上 |
| --- | --- | --- |
| 右键 | 新建节点 / 粘贴 / 自动布局 | 重命名·编辑简介·添加文档·发起连线·复制·删除·标记颜色 |
| 左键单击 | 取消选中 / 开始框选 | 选中（打开内容面板） |
| 左键双击 | 新建节点 | 编辑标题 |
| 拖拽 | 框选 | 移动节点 |
| 从边缘锚点拖拽 | — | 拉出连线 |
| 悬停 400ms | — | 显示简介卡片 |
| Ctrl+滚轮 | 以光标为锚点缩放 | 同左 |
| 滚轮 | 垂直平移 | 同左 |
| 空格+拖拽 | 平移 | 平移 |
| Delete | 删除选中项 | 删除选中项 |
| Ctrl+Z / Ctrl+Shift+Z | 撤销 / 重做 | 同左 |
| Ctrl+Shift+A | 打开 AI 对话窗口 | 同左 |

---

## 5. 技术架构

### 5.1 技术选型与理由

| 环节 | 选型 | 理由 | 备选与放弃原因 |
| --- | --- | --- | --- |
| 应用外壳 | **Tauri 2.x**（Rust 后端 + 系统 WebView） | 产物 ~8MB / 内存 ~40–80MB / 秒开，对"随身带着的笔记本阅读工具"最契合；macOS 走 WKWebView 表现优秀；多窗口原生支持（阅读窗口、AI 窗口）；本机 Rust 1.95 已就绪、构建链已验证 | Electron：npm 生态与跨端渲染一致性更好，但 120MB+ 体积与高内存占用。**已选 Tauri**；Electron 作为回退方案保留 |
| Rust 后端 | **Rust（src-tauri）** | 负责文件读写、多窗口管理、AI 请求与工具调用、密钥存储；类型安全、性能好 | Node 后端：体积与内存劣势 |
| 构建 | **Vite + Tauri CLI** | 前端 HMR 快；`tauri build` 出各平台原生包；`tauri-action` 负责 CI | — |
| 前端框架 | **React 18 + TypeScript** | 生态成熟；面板/设置等 UI 开发快 | 原生 JS：白板性能可控但 UI 代码量翻倍 |
| 状态管理 | **Zustand + 命令栈** | 轻量；撤销/重做用命令模式包一层即可 | Redux：样板代码过多 |
| **白板画布** | **自研：SVG 连线层 + DOM 节点层** | 节点规模在数百量级，DOM 便于文本渲染/内联编辑/CSS 动效；SVG 便于贝塞尔曲线与箭头 marker；动效与视觉 100% 可控 | React Flow：开箱即用，但默认样式重、深度定制动效时反而掣肘；Canvas：性能上限高，但文本编辑与动效都要自己实现 |
| Markdown 渲染 | **复用 mdread 内核**（markdown-it 14 + 定制规则 + KaTeX 0.16，全部本地 vendor） | 已在 Android 端验证：400KB 文档毫秒级解析、公式两级保护、分批排版；**零重复劳动** | 重新解析：会重踩一遍 mdread 已修的公式坑 |
| PDF（二期） | **pdf.js**（本地内置） | 离线、纯前端 | — |
| AI 接入 | **Provider 抽象层 + 工具调用**（实现于 Rust 侧：`reqwest` 发请求 + SSE 流式解析） | 用户要求"按需读取"而非全量塞入；工具调用天然匹配；放在 Rust 侧可避免 API Key 进入前端 | 全量塞上下文：长白板必然超 token |
| 存储 | **文件系统 + JSON**（无数据库） | 用户明确要求"白板 = 一个文件夹，里面有 md 和树结构"；文件即数据 → 可用 Git 管理、可备份、AI 直接读 | SQLite/IndexedDB：与"文件夹即白板"的诉求冲突 |
| 测试 | **Vitest**（内核纯函数 + 状态逻辑）+ 复用 mdread 的 `check_offline.js` / `check_tocpage.js`；E2E 留到 M7（`tauri-driver` + WebdriverIO） | 分层；渲染内核为纯函数，天然可单测；Tauri 的 E2E 依赖平台 WebDriver，一期先用手工清单覆盖 | — |

### 5.2 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│ Rust 后端（src-tauri，拥有文件系统与网络权限）                │
│                                                             │
│  ┌──────────────┐ ┌──────────────┐ ┌─────────────────────┐  │
│  │ BoardRepo    │ │ WindowManager│ │ AiService           │  │
│  │ 项目/白板/文档│ │ 主窗/阅读窗/  │ │ Provider 抽象        │  │
│  │ 读写·原子写  │ │ AI 窗 多实例  │ │ reqwest + SSE 流式   │  │
│  └──────┬───────┘ └──────┬───────┘ └──────────┬──────────┘  │
│         │                │                    │             │
│  ┌──────┴────────────────┴────────────────────┴──────────┐  │
│  │ Tauri Commands（invoke，最小命令面）+ Events（流式推送） │  │
│  └──────┬──────────────────────────────┬───────────────┬─┘  │
└─────────┼──────────────────────────────┼───────────────┼────┘
          │                              │               │
┌─────────┴──────────────┐  ┌────────────┴──────┐  ┌────┴──────┐
│ WebView: 白板           │  │ WebView: 阅读窗口  │  │ WebView:  │
│  CanvasEngine(SVG+DOM) │  │  mdread 内核移植    │  │ AI 对话   │
│  NodeLayer / EdgeLayer │  │  markdown-it+KaTeX │  │ 流式+渲染 │
│  Store + 命令栈(undo)   │  │  TOC/字号/进度记忆 │  │ 引用回链  │
└────────────────────────┘  └───────────────────┘  └───────────┘
   macOS: WKWebView            Windows: WebView2

磁盘：<用户指定根目录>/<项目>/<白板>/{ board.json, docs/*.md }
```

### 5.3 Rust 后端模块（`src-tauri`）

| 模块 | 职责 |
| --- | --- |
| `BoardRepository` | 项目/白板/文档的 CRUD；原子写；目录监听（`notify` crate）；快照 |
| `WindowManager` | 主窗口、阅读窗口（多实例，按 `boardId:docPath` 复用）、AI 窗口的创建与生命周期 |
| `AiService` | Provider 适配（OpenAI 兼容 / Anthropic / Ollama）；工具定义与执行；SSE 流式解析与转发；token 预算与截断 |
| `ConfigStore` | 设置持久化（根目录、主题、模型配置）；API Key 用系统钥匙串加密存储 |
| `DocImporter` | 文件导入（复制/移动、重名处理、编码探测、生成节点） |

**为什么把 AI 放在 Rust 侧**：API Key 不进入前端 WebView，避免被页面脚本或误提交泄露；流式解析在后端完成，只把文本增量推给前端。

### 5.4 渲染进程模块（白板）

| 模块 | 职责 |
| --- | --- |
| `CanvasEngine` | 视口（平移/缩放）变换、坐标换算（屏幕↔世界）、网格绘制 |
| `NodeLayer` | DOM 节点渲染、内联编辑、拖拽、多选 |
| `EdgeLayer` | SVG 贝塞尔连线、箭头 marker、锚点吸附、连线拖拽 |
| `Store` | 单一状态源；所有变更**必须**经过命令（Command）以保证 undo/redo |
| `InteractionController` | 鼠标/键盘事件路由到具体命令 |
| `Tooltip` / `NodePanel` | 悬停简介、节点内容面板 |

**性能策略**：
- 平移/缩放只改**容器 transform**（`translate3d` + `scale`），不逐个重排节点；
- 视口外的节点用**虚拟化**（按包围盒剔除）暂不挂载 DOM；
- 连线在拖拽期间降级为直线，停止拖拽后恢复贝塞尔（避免每帧重算路径）。

### 5.5 渲染管线（移植自 mdread）

```
Markdown 文本
  └─ DocumentLoader：BOM 探测 → UTF-8 → GB18030 回退
       └─ engine.js（纯函数，可单测）
            ├─ 自定义 block 规则 md_math_block：整块吞 $$…$$ / \[…\]，登记为段落终止符
            │    （修复 `=` `-` 独占行被当成 setext 标题/列表）
            ├─ 自定义 inline 规则 md_math_inline：转义前吞 $…$ / \(…\) / \[…\]
            ├─ 标题锚点 slug 注入（重复标题自动 -2/-3）
            └─ 目录收集（与渲染共用同一次遍历，O(n)）
       └─ 一次性上屏 HTML
            └─ reader.js：按顶层块建排版队列 → 先排视口附近 → requestIdleCallback 每帧 ~5ms
                 └─ KaTeX 分批排版（代码块打 .no-math 跳过）
```

**关键**：`engine.js` 是纯函数，因此**可在 Node 侧单测**——mdread 的 `scripts/check_offline.js`（18 条断言）与 `check_tocpage.js`（11 条）应原样迁移，作为本项目的回归防线。

### 5.6 AI 上下文与工具调用设计

**为什么用工具调用**：用户明确要求"根据需要读取相应的内容"。全量塞入在 20+ 节点的白板上必然爆 token，且模型注意力被稀释。

```
System: 你是「脉络」的研究助理，正在就白板《{boardName}》回答问题。
        先用 read_board_outline 了解结构，再用 read_node_doc 按需取全文。
        引用节点时用 [[node:<id>]]，可引用多个。
        回答使用 Markdown + LaTeX（行内 $…$，块级 $$…$$）。

Tools:
  read_board_outline()                      → 树状结构 + 全部节点标题/简介
  list_nodes()                              → 节点清单（id/标题/文档数/更新时间）
  read_node_doc(node_id, doc_index?, offset?, limit?)  → 全文（超长分段+截断提示）
  search_board(query, max_results?)         → 命中片段（含节点 id 与上下文行）
```

**Token 预算策略**：
1. `outline` 全量给（标题+简介，通常 <2k token）；
2. 单文档 >12k 字符时分段返回，并提示模型可继续取；
3. 对话历史只保留最近 N 轮 + 摘要滚动压缩。

**引用回链**：模型输出中的 `[[node:xxx]]` → 渲染为可点击 chip → IPC 通知主窗口 → 视口缓动居中 + 节点高亮脉冲。

### 5.7 前后端接口约定（Tauri Commands / Events）

- **原则**：前端 WebView **没有任何文件与网络能力**；所有 IO 走 `invoke` 命令，权限由 Tauri 的 capability 系统声明，参数一律在 Rust 侧校验（路径必须在已授权范围内）。
- 命令分组：
  - `board_*`：项目/白板的增删改查与持久化
  - `doc_*`：导入、打开、读取文档内容
  - `reader_*`：阅读窗口的创建与控制
  - `ai_*`：发起对话、执行工具、取消
  - `config_*`：设置读写、API Key 存取
- 流式 AI 用 **Tauri Event** 推送：`ai://stream` → `{ type: 'delta' | 'tool_call' | 'done' | 'error', ... }`。
- 权限声明集中在 `src-tauri/capabilities/default.json`，**默认最小权限**，只给必要的 fs scope 与 http scope。

### 5.8 安全与隐私

| 项 | 措施 |
| --- | --- |
| 前端沙箱 | Tauri capability 权限模型：前端无 Node / fs / shell 能力，仅能调用显式声明的命令；fs scope 限制在用户授权目录 |
| 外部链接 | 一律走系统默认浏览器打开，不在应用内加载远程内容 |
| 数据存储 | 全部本地；不上传任何文档（AI 提问时才按工具调用结果发送**被读取的片段**） |
| API Key | 存系统钥匙串（macOS Keychain / Windows 凭据管理器），**不进前端、不进 `board.json`、不写日志** |
| 密钥与仓库 | 私密文件一律放 `.local/`（已 gitignore）；提交前跑 `scripts/check_secrets.js` 扫描，见 §11.6 |
| 依赖 | 渲染资源（markdown-it / KaTeX / pdf.js / 字体）全部离线内置 |

---

## 6. 数据模型

### 6.1 磁盘目录结构

```
<用户指定根目录>/
├── index.json                      # 项目索引（轻量，避免全量扫描）
├── <project-id>/
│   ├── project.json                # 项目元信息
│   └── <board-id>/
│       ├── board.json              # 白板：节点、连线、视口（树状结构在此）
│       ├── docs/                   # 该白板的全部 Markdown / PDF 原文
│       │   ├── <node-id>-<slug>.md
│       │   └── …
│       └── .snapshots/             # 可选快照（P2）
```

> **设计要点**：`board.json` 与 `docs/` 同处一个文件夹 → 整块白板可复制、可 Git 化、可整体搬走；AI 只需这一个文件夹即可获得完整上下文（对应用户原话 (a)）。

### 6.2 `index.json`

```json
{
  "version": 1,
  "projects": [
    { "id": "p_diffusion", "name": "扩散模型", "createdAt": "2026-09-06T10:00:00Z" }
  ]
}
```

### 6.3 `project.json`

```json
{
  "version": 1,
  "id": "p_diffusion",
  "name": "扩散模型",
  "createdAt": "2026-09-06T10:00:00Z",
  "updatedAt": "2026-09-06T10:00:00Z",
  "boards": [
    { "id": "b_math", "name": "数学基础", "updatedAt": "2026-09-06T11:00:00Z" }
  ]
}
```

### 6.4 `board.json`

```json
{
  "version": 1,
  "id": "b_math",
  "name": "数学基础",
  "projectId": "p_diffusion",
  "createdAt": "2026-09-06T10:05:00Z",
  "updatedAt": "2026-09-06T11:30:00Z",
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "nodes": [
    {
      "id": "n_elbo",
      "title": "什么是 ELBO（证据下界）？",
      "summary": "用 Jensen 不等式把 log p(x) 的下界写成 E_q[log p(x,z)/q(z)]，等价于最小化 KL。",
      "x": 240, "y": 160,
      "w": 240,
      "color": null,
      "docs": [
        { "path": "docs/n_elbo-01.md", "title": "GPT 回答：ELBO 推导", "bytes": 12480 }
      ],
      "createdAt": "2026-09-06T10:06:00Z",
      "updatedAt": "2026-09-06T10:06:00Z"
    }
  ],
  "edges": [
    {
      "id": "e_1",
      "from": "n_elbo",
      "to": "n_vi",
      "directed": true,
      "label": "追问",
      "createdAt": "2026-09-06T10:10:00Z"
    }
  ]
}
```

**字段说明**

| 字段 | 说明 |
| --- | --- |
| `nodes[].w` | 只存宽度，高度由文本自动撑开（避免换行变化导致高度错位） |
| `docs[].path` | **相对白板文件夹**的相对路径，保证整个根目录可移动 |
| `edges[].directed` | `true` = 有向（追问/派生），`false` = 无向（相关） |
| `version` | 用于迁移；读取时若 `version` 低于当前，走迁移函数 |

### 6.5 写入策略

| 策略 | 做法 |
| --- | --- |
| 原子写 | 写 `board.json.tmp` → `fsync` → `rename` 覆盖，杜绝断电半截文件 |
| 防抖 | 状态变更后 1s 防抖落盘；窗口 `close`/`blur` 前强制 flush |
| 冲突 | 单用户应用；目录监听发现外部改动时提示"已在外部修改，是否重新加载" |
| 快照（P2） | 打开白板前复制一份到 `.snapshots/`，保留最近 20 份 |
| 迁移 | `migrations/v1→v2.ts` 链式执行；迁移前自动备份 |

---

## 7. 非功能需求

| 类别 | 指标 |
| --- | --- |
| 性能 | 500 节点/2000 连线平移缩放 ≥55 FPS；400KB 文档首屏 <500ms；AI 首字延迟取决于供应商，UI 需在 100ms 内给出"正在思考"反馈 |
| 体积 | 安装包 **≤20MB**（Tauri 基线 + KaTeX 字体）；加入 pdf.js 后 ≤30MB |
| 离线 | 除 AI 对话外，全部功能断网可用；渲染资源零外链 |
| 可靠 | 崩溃不丢数据（原子写 + 防抖 flush）；异常一律用户可读提示，不弹原始 stack |
| 可维护 | 渲染内核为纯函数且有单测；UI 与状态分离；所有 IO 收敛在 `BoardRepository` |
| 可移植 | 数据目录可整体拷贝/迁移；不做机器绑定 |
| 可访问性 | 键盘可完成主要操作；尊重 `prefers-reduced-motion`；缩放 400% 下 UI 不破版 |

---

## 8. 测试策略

| 层 | 工具 | 覆盖内容 |
| --- | --- | --- |
| 单元 | Vitest | `engine.js`（Markdown→HTML+目录，纯函数）、slug 唯一性、公式保护规则、坐标换算、命令栈 undo/redo |
| 回归 | 迁移自 mdread 的 `scripts/check_offline.js`、`check_tocpage.js` | 渲染内核的已知坑（块级公式内 `=` `-` 独占行、裸 `\tau` 等） |
| 组件 | Vitest + Testing Library | 节点编辑、连线交互、面板 |
| E2E | Playwright（Electron） | 建项目→建白板→建节点→导入 md→连线→打开阅读窗口→AI 提问引用跳转 |
| 手工 | 清单 | IME 输入、多显示器、深色模式、超大文档、断网 AI |

**覆盖率目标**：渲染内核与状态逻辑 ≥80%，UI 层以 E2E 关键路径为主。

---

## 9. 里程碑与交付

详见 [进度规划](./PLAN.md)。概要：

| 阶段 | 目标 |
| --- | --- |
| M0 | 立项：设计文档、进度规划、仓库骨架 |
| M1 | 骨架：Tauri 壳 + Rust 存储层 + 项目/白板管理 + 设置 |
| M2 | 白板 v1：节点增删改、拖拽、平移缩放、悬停简介 |
| M3 | 连线：有向/无向、锚点拖拽、撤销重做 |
| M4 | 内容与阅读窗口：md 导入 + mdread 内核移植（子集功能完成） |
| M5 | AI 对话：FAB + 独立窗口 + 工具调用 + 引用回链 |
| M6 | 打磨：三主题、动效、PDF、自动布局、导出 |
| M7 | 发布：打包、更新、文档、验收 |

---

## 10. 风险与开放问题

### 10.1 待确认决策（需要你拍板）

| ID | 问题 | 我的建议 |
| --- | --- | --- |
| ~~**O-1**~~ | ~~项目命名与仓库位置~~ | ✅ **已定：脉络（Lumen）**。仓库名 `lumen`，包名 `com.lumen.app`；mdread 阅读内核作为 `packages/reader` 子集引入。当前工作区目录 `mdreadPC` 仅为开发期路径，Git 仓库名与之解耦 |
| ~~**O-2**~~ | ~~技术栈：Electron vs Tauri~~ | ✅ **已定：Tauri 2.x + React + TS + Vite**。理由：主平台为随身笔记本（体积小、内存低、秒开），且本机 Rust 1.95 与构建链已验证。Electron 保留为回退方案 |
| **O-3** | AI 供应商与鉴权方式 | 建议先做 OpenAI 兼容（可填 baseURL）+ 本地 Ollama 两类，用户自填 Key |
| **O-4** | "点击 PDF"的准确含义 | 我理解为"点击节点绑定的文档（md 或 pdf）→ 独立阅读窗口"。若确指 PDF，则 pdf.js 优先级要上调 |
| **O-5** | 结构自由度 | 你说"树状"，但允许节点间错综连接 → 数据结构用**图**存储、默认呈现为树。请确认是否需要强制单根/单父 |
| **O-6** | 是否需要从 ChatGPT 直接导入对话（而非手动导出 md） | 一期手动导出，二期评估官方导出 JSON 解析 |

### 10.2 风险登记

| ID | 风险 | 影响 | 概率 | 缓解措施 |
| --- | --- | --- | --- | --- |
| R-1 | Electron 包体积与启动速度 | 中 | 高 | 按需加载阅读窗口；延迟加载 pdf.js |
| R-2 | 公式渲染在桌面大屏下的排版细节与移动端不同 | 中 | 中 | 直接迁移 mdread 内核 + 回归套件，先跑通再优化 |
| R-3 | AI 工具调用在长白板上上下文超限 | 中 | 中 | outline-first + 分段读取 + 历史压缩（§5.6） |
| R-4 | 自研画布工作量大、动效打磨耗时 | 高 | 中 | 先出骨架再打磨；M6 专门留给动效；必要时回退 React Flow |
| R-5 | 文件被外部删除/改名导致悬空引用 | 低 | 高 | 节点标记"文件缺失"并提供重新定位 |
| R-6 | 需求蔓延（思维导图全功能） | 高 | 中 | 严守 §1.4 非目标；新需求先进 PLAN 待办再排期 |

---

## 11. 跨平台与发布策略

### 11.1 平台优先级

| 平台 | 定位 | 说明 |
| --- | --- | --- |
| **macOS（Apple Silicon / arm64）** | **主目标** | 主力使用平台；GitHub Actions 用 `macos-15` 标签 |
| Windows（x86_64） | 次要 | 当前 MCP 开发机；Actions 用 `windows-latest` |
| Linux | 一期不做分发 | 仅用于 CI 跑 lint / 单测（1× 分钟，最便宜） |

> 依据：GitHub 已下线 macOS 13 runner，Intel 仅剩 `macos-15-intel` 标签，x86_64 架构在 2027 年秋后不再支持 [4](https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/)。因此**新项目直接以 arm64 为主、x86_64 为可选**。

### 11.2 代码托管与开源

- **开发期用私有仓库，功能成型后转公开。**
- **公开 = Actions 标准 runner 分钟数不限**，macOS 的 10× 倍率随之失效（公开仓库不受额度约束）[1](https://costops.dev/guides/how-github-actions-billing-works)。
- **历史整洁靠"整理"而非"少提交"**：开发期可以细粒度提交（便于回滚与定位问题），公开前用 `git rebase -i` 压成若干有意义的提交，或新建仓库导入一份干净快照。这样既保留回滚能力，又不必把探索过程公开。
- **公开后的安全红线**：
  - Actions 日志对所有人可见 → **任何 secret 都不得 echo 到日志**；
  - 仓库内不得出现任何密钥 → `.gitignore` 已忽略 `.env*`；AI 的 API Key 只存在用户本机（Electron `safeStorage` / Tauri stronghold），永不入库。

### 11.3 构建节奏（把 CI 用在刀刃上）

**提交 ≠ 构建。** 提交是本地秒级操作，成本几乎为零；真正消耗时间的是 CI 构建与等待。因此分离二者：

| 触发条件 | 跑什么 | 分钟成本 |
| --- | --- | --- |
| 每次 push / PR | **仅 Linux**：lint + `tsc` + 单测 + mdread 回归套件 | 1×，可忽略 |
| **里程碑完成打 tag**（M2 / M4 / M5 / M7） | macOS（arm64）+ Windows 构建，产出 dmg / exe | 10×，缓存后每轮约 3–6 分钟 |

**约定：整轮开发预计只构建 4–6 次**，既不是每次提交都构建，也**不是最后只构建一次**。

> **为什么不赞成"最后只构建一次"**：目标平台是 macOS，而开发在 Windows 上进行。若到 M7 才第一次打包，签名、架构、路径分隔符、窗口安全区、字体行高、WebView 差异等问题会**在同一时刻集中爆发**，排查成本远高于分阶段构建。按里程碑构建相当于把风险摊薄——每次只需面对当阶段引入的差异。

**CI 必备优化**：`swatinem/rust-cache` + `actions/setup-node` 的 npm 缓存，把冷构建从 15–25 分钟压到 3–6 分钟。

### 11.4 签名与公证（自用策略）

| 场景 | 是否需要 Apple Developer（$99/年） | 用户侧体验 |
| --- | --- | --- |
| 自己的 Mac | **不需要** | 首次需右键 → 打开（或"隐私与安全性"中点"仍要打开"） |
| 给一两位朋友 | **不需要** | 同上，需提前告知这一步 |
| 公开发布 / 大规模分发 | 需要 | 双击即装，无 Gatekeeper 拦截 |

**一期决策：不买证书，出未签名（ad-hoc）构建。** 自用与极小范围分享完全够用；日后若要公开发布，CI 侧只需补 secrets（`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`），`tauri-action` 会自动完成签名 → 公证 → staple → 上传 Release [5](https://dev.to/massi_24/shipping-a-production-macos-app-with-tauri-20-code-signing-notarization-and-homebrewpublish)。Electron 侧对应 `electron-builder` + `@electron/notarize`，改动量相当。

> 注：ad-hoc 签名不能免除 Gatekeeper 的拦截，只是让应用能在本机运行 [6](https://v2.tauri.app/distribute/sign/macos/)。另外，若将来启用 Tauri 自带自动更新，更新包必须签名（`TAURI_SIGNING_PRIVATE_KEY`）；**一期不做自动更新，可跳过**。

### 11.5 跨平台实现清单

| 项 | 处理 |
| --- | --- |
| 路径 | 一律 `path.join`；`board.json` 里 `docs[].path` 存**相对路径**（已如此设计），保证目录可整体迁移 |
| 快捷键 | macOS 用 `Cmd`，Windows/Linux 用 `Ctrl`；统一以 `process.platform === 'darwin'` 映射 |
| 标题栏 | macOS 红绿灯在左、拖拽区更高；Windows 三键在右；自定义标题栏需按平台适配安全区 |
| 字体与行高 | 两端渲染不同，节点宽度自适应须在两个平台各验证一次 |
| 文件权限 | macOS 沙箱与 Windows ACL 行为不同；用户选定目录的持久化访问需分别验证 |
| WebView | 若用 Tauri：macOS 为 WKWebView、Windows 为 WebView2，CSS 与动效需各验一次；若用 Electron 则天然一致 |
| 数据同步 | 存储根目录可设在同步盘（iCloud / OneDrive / Dropbox）实现跨设备共用；须避免两端同时编辑同一白板 |

---

### 11.6 密钥与私密文件管理

**约定一：私密文件一律放仓库内 `.local/` 目录，该目录被 gitignore**

```
lumen/
├── .local/                    ← 私密目录，已 gitignore，永不入库
│   ├── README.md              ← 说明此处用途
│   ├── env                    ← 环境变量（API Key、base URL…）
│   └── notes/                 ← 令牌、端点地址、本地笔记…
├── .env.example               ← 入库：只有键名与占位符
└── scripts/check_secrets.js   ← 入库：提交前密钥扫描
```

**约定二：`.gitignore` 覆盖范围**（已落地）

| 类别 | 忽略项 |
| --- | --- |
| 私密目录 | `.local/`、`.env*` |
| 证书与密钥 | `*.p12`、`*.pfx`、`*.pem`、`*.key`、`*.keystore` |
| 本项目特有风险 | `*token*`、`mcp-endpoint.txt` |
| 例外（必须入库） | `!.env.example`、`!scripts/**` |

**约定三：光有 `.gitignore` 不够，必须有扫描兜底**

`.gitignore` 只能挡住**未跟踪**的文件。下面三种情况它拦不住，因此需要 `scripts/check_secrets.js`：

1. 误用 `git add -f` 强制添加被忽略的文件
2. 文件**先被提交**、事后才加入 `.gitignore`（已被跟踪的文件不受忽略规则约束）
3. 密钥被硬编码进某个源码文件（例如调试时临时写死）

脚本扫描**已暂存内容**（`git diff --cached`）是否命中高危模式：`sk-` 开头的 OpenAI Key、`dsh-` 令牌、`trycloudflare.com` 端点、`-----BEGIN ... PRIVATE KEY-----`、`ghp_` GitHub Token 等。命中即以非零码退出。

> **用法**：`node scripts/check_secrets.js`。暂不挂 git hook（避免干扰日常小步提交），建议在**推送前**与**仓库转公开前**各跑一次。

**约定四：仓库转公开前的检查清单**

- [ ] 跑 `node scripts/check_secrets.js`，无命中
- [ ] `git log --all --full-history -- .local .env` 确认历史上从未提交过私密文件
- [ ] 确认 CI 日志中无任何敏感回显
- [ ] （可选）`git rebase -i` 整理提交历史

---

## 附录 A：关键决策记录（ADR 摘要）

| ADR | 决策 | 理由 |
| --- | --- | --- |
| ADR-001 | 文件即数据，不用数据库 | 契合"白板 = 文件夹"诉求；可 Git、可备份、AI 直接读 |
| ADR-002 | 自研画布（SVG 连线 + DOM 节点） | 动效与视觉完全可控；规模在数百节点，DOM 足够 |
| ADR-003 | 阅读器直接移植 mdread 内核 | 已验证的公式保护与分批排版；避免重踩坑 |
| ADR-004 | AI 取数用工具调用而非全量上下文 | 符合用户"按需读取"要求；避免 token 爆炸 |
| ADR-005 | 结构用图存储、呈现为树 | 真实研究脉络有交叉引用，强制树会失真 |
| ADR-006 | 渲染进程不直连文件系统 | 安全边界；所有 IO 经主进程校验 |
| ADR-007 | 按里程碑构建（约 4–6 次），而非每次提交构建或最后只构建一次 | CI 成本可控，同时避免 macOS 平台问题在末期集中爆发 |
| ADR-008 | 一期不做代码签名与公证，出 ad-hoc 构建 | 自用与极小范围分享够用；待公开发布时补 secrets 即可，改造成本低 |
| ADR-009 | **选 Tauri 2.x 而非 Electron** | 主平台是随身笔记本：体积 8MB vs 120MB+、内存 40–80MB vs 150–400MB、秒开 vs 2–5s；本机 Rust 工具链已就绪。代价是 AI 流式与文件 IO 需用 Rust 实现（一次性成本，由开发侧承担） |
| ADR-010 | 私密文件集中在仓库内 `.local/` 目录并 gitignore，提交前跑密钥扫描 | 兼顾"方便取用"与"绝不入库"；`.gitignore` 只能防未跟踪文件，故需扫描脚本兜底（防误 `git add -f`、防已跟踪文件泄密） |
| ADR-011 | `CanvasEngine` 拆为「纯函数内核 + 薄类封装」，坐标换算不碰 DOM | 纯函数可在 Node 侧直测（DESIGN §8），把容器 `getBoundingClientRect()` 作为参数传入即可；类只持有视口状态并委托纯函数，便于未来接入 Store/命令栈 |
| ADR-012 | 缩放以「屏幕锚点世界点不动」为不变量（zoomAtPoint），视口用 `translate3d+scale` 整体变换 | 滚轮/捏合缩放手感的正确性可用单测钉死（往返一致、锚点不动）；容器整体 transform 避免逐节点重排，配合包围盒剔除做虚拟化（DESIGN §5.4 性能策略） |
| ADR-013 | 自定义标题栏采用 native_mac 策略（mac 保留系统红绿灯 + Overlay，Win/Linux 自绘） | 主目标是 macOS：遵循各系统窗口惯例（mac 红绿灯在左、Win 按钮在右）比强行统一更符合用户肌肉记忆；实现上 mac 用 titleBarStyle=Overlay + hiddenTitle，其它平台 decorations=false 前端自绘 |
| ADR-014 | 列表操作从「底部常驻表单」改为右键菜单 + 内联编辑 | 底部固定表单占用垂直空间且与白板极简气质不符；右键菜单（空白=新建、条目=打开/重命名/删除）+ 就地内联输入更贴近桌面应用直觉，ContextMenu 组件后续可复用于画布节点（M2-3） |
| ADR-015 | 液态玻璃采用「跨引擎一致的毛玻璃核心」而非 SVG 位移真折射 | 主目标 macOS 用 WKWebView(Safari)，SVG feDisplacementMap 在其 `backdrop-filter` 内不生效，业界"真折射"库(rdev/liquid-glass、glass-refraction 等)在 Safari 上都会退化为普通毛玻璃。故抽取各库共有、双引擎一致的核心：分层 `backdrop-filter: blur()+saturate()` + 半透明染色 + 亮边高光 + 每主题染色变量；透明度/模糊在设置里可调、持久化到 localStorage。零 npm 依赖、可控可回退(关玻璃即实色) |
| ADR-016 | 节点承载「概括标题 + 完整问题」两属性，Markdown 文档移入点击气泡卡 | 卡面只放十几字标题(大字)+完整问题(自适应高度、`white-space:pre-wrap` 防长文本被截尾)，保持画布清爽；关联的 GPT 导出 .md 在点击节点后于鼠标附近的玻璃气泡卡(NodeBubble)里列出，符合"按需查看"。数据模型早已含 title/summary/docs，无需改后端 |
| ADR-017 | 液态玻璃改用原生 OS 窗口材质（tauri-apps/window-vibrancy）而非纯 CSS | CSS backdrop-filter 只能模糊应用自身、且被浮层重叠的内容；外壳(侧栏/标题栏)无重叠内容可透，看不出玻璃；且 macOS 的 WKWebView 不渲染 SVG 折射。正解是让窗口透明(transparent:true + macOSPrivateApi:true)，由 OS 在窗口背后合成真实材质：macOS 26+ = Apple 原生 Liquid Glass(apply_liquid_glass)，旧 macOS 回退 Vibrancy，Windows 11 = Mica/Acrylic。前端把外壳背景改透明让材质透上来。设置里保留 原生/网页/关闭 三档(glassMode)，网页档为跨平台一致的 CSS 兜底 |
| ADR-018 | window-vibrancy 暂用 git dev 分支依赖 | apply_liquid_glass(macOS 26+) 尚未进 crates.io 发布版(最新 0.8.0 只有 vibrancy/mica/acrylic)，仅存在于 dev 分支；为拿到 Mac 原生液态玻璃先 pin git branch=dev(commit e9f765a)，待其正式发版后切回 crates.io 版本号 |
| ADR-019 | Windows/Linux 放弃原生材质、改纯实色主题；原生液态玻璃仅 macOS 生效 | 实测 Win11 Mica 只对桌面壁纸做一次全局采样染色（透出的是壁纸色而非窗口背后的真实像素，用户看到"整片米黄"），且随窗口聚焦/失焦切换渲染导致焦点变色，观感差；Acrylic 虽真半透明取背后像素但整窗使用耗 GPU、拖拽掉帧，微软亦不建议长驻背景用。真正"混合桌面背景"的体验只有 macOS 的 NSVisualEffectView/Liquid Glass 能提供。故：`apply_native_material` 仅 `#[cfg(target_os="macos")]`，Cargo 依赖 window-vibrancy 只保留 macOS target；前端 `applySettings(s, platform)` 中 `native` 档在非 macOS 退化为 `off`（纯实色），设置面板"原生"按钮在非 Mac 平台禁用并标注"·仅Mac"。网页 CSS 玻璃档仍跨平台可用 |
| ADR-020 | 连线用 SVG 层绘于世界坐标、几何抽为纯函数（DESIGN §5.4 EdgeLayer） | 连线 = SVG 贝塞尔曲线，画在 `.canvas-world` 内、随其 `transform` 一起平移缩放，故几何只需算一次世界坐标即可跟随视口；端点吸附用「射线与节点矩形边框求交」纯函数(borderPoint)，曲线控制柄沿离开节点的外法向伸出得到自然弧线。几何全部落在 `src/canvas/geometry.ts` 纯函数（borderPoint/edgeGeometry/boxContains…），可在 Node 侧单测（12 用例，往返/吸附/命中）；节点真实尺寸经 ResizeObserver 测得后传入（世界单位，不受缩放影响）。连线拖拽期降级为直线预览避免每帧算贝塞尔（DESIGN 性能策略）。stroke 用 `vector-effect:non-scaling-stroke` 使线宽不随缩放变粗 |
| ADR-021 | 外壳（侧栏/标题栏）从冷灰 #f6f7f9 改为近白微青绿，靠发丝边框+强调色悬停做层次 | 用户反馈灰色块显沉闷。改 `--bg-chrome` 为近白带一丝主题冷青绿(#fbfdfc)，`--bg-hover` 从中性黑改为强调色淡染(rgba(46,90,78,.08))、边框改带绿的浅色，使侧栏/顶栏更清新明亮，与纯白主区仍有可辨层次但不再灰。三主题各自给了协调的 `--edge-color`/`--edge-label-bg` 连线配色 |

| ADR-022 | 连线层改为「覆盖整块画布的全尺寸 SVG 覆盖层、用屏幕坐标绘制」，而非画在 0×0 世界层内 | 初版把连线 SVG 放进 `.canvas-world`（该容器 `width:0;height:0`，靠 transform 定位节点），但 Chromium/WebView2 对「零尺寸视口的 SVG」常直接不绘制——导致连线与拖拽预览完全不可见（表现为"拖不出线/没有线"）。改为 `.edge-layer` 绝对定位铺满画布容器(`inset:0;width/height:100%`)，节点屏幕包围盒 = 世界坐标经 `engine.toScreen` + `zoom` 换算(screenBoxOf)，几何用屏幕坐标算并把视口签名 vpSig 并入 useMemo 依赖，故平移/缩放时连线实时重算跟随；线宽用固定屏幕像素(不再需要 non-scaling-stroke)。edge-layer 在 DOM 上位于世界层之前、pointer-events:none（仅命中区 path 开启），故连线在节点卡片之下且不挡节点交互 |

| ADR-023 | 连线样式做成可切换设置（曲线/直线/折线），几何在同一 edgeGeometry 里按 style 分支 | 用户希望连线不止一种形状。端点吸附(borderPoint)对三种样式一致，仅路径生成不同：curved=三次贝塞尔(控制柄沿离开节点外法向)、straight=两吸附点直线、stepped=正交折线(按主导轴 H-V-H/V-H-V，中点取拐点放标签)。样式存 Settings.edgeStyle 持久化、经 App 传入 BoardCanvas 并入 laidEdges 的 useMemo 依赖，切换即时重绘；纯函数分支可单测（geometry.test +5） |

| ADR-024 | 节点交互升级为「悬停 Tooltip + 选中停靠 NodePanel」，取代点击浮动气泡 | 点击浮动气泡(NodeBubble)会遮挡画布且定位漂移。改为：悬停 400ms 出只读简介 Tooltip(轻量、pointer-events:none)；点击节点在画布右侧停靠 NodePanel(常驻、可滚动)承载 查看/编辑标题与完整问题、颜色标记(node.color→卡片左边框色条)、关联文档列表(M4 接入导入/打开)、二次确认删除。为防在面板文本域打字时触发画布级快捷键(如 Backspace 删节点)，window keydown 增加"目标为 input/textarea/contenteditable 则跳过"的守卫。NodeBubble 组件废弃删除 |

| ADR-025 | 节点颜色标记升级为「卡片强调色」；右键菜单精简；曲线改单拱弧 | ① 颜色不再只是左边色条：NodeCard 注入 CSS 变量 --node-accent（=node.color，未设回退 var(--accent)），选中边框/outline/热力光晕/连线锚点均引用之，软环用 color-mix 从该色派生；左侧色条 3→6px 更醒目。② NodePanel 已完整覆盖节点编辑，故删除节点右键菜单的「编辑」项，节点右键改为直接打开面板且仅保留「删除节点」。③ curved 连线由「1/3、2/3 双控制点等距偏移」（中段平顶大肚、不好看）改为「弦中点朝垂直方向抬起拱高→二次贝塞尔过拱顶→精确升阶三次贝塞尔」的单拱对称弧，拱高收敛为 clamp(dist*0.14,14,60)，仍输出 SVG 'C' |

| ADR-026 | M4 阅读内核改为基于 npm(markdown-it + KaTeX) 从零搭，而非迁移 Android mdread 资产；阅读窗口取「独立 Tauri 窗口 + 应用内浮层回退」双形态 | PLAN 原定迁移同级 Android 项目 `mdread/app/src/main/assets/reader/` 的 engine.js/reader.js/reader.css 及回归套件，但该目录不在本仓库、构建环境不可达。经与用户确认（Mac 优先、效果好），改用 npm 依赖从零实现同等能力：engine.ts（公式两级保护→占位元素、标题 slug 保留中文、TOC 收集，纯函数可单测）+ reader.ts（KaTeX 用 rAF 分批排版，出错就地降红）。回归套件以 vitest engine.test.ts 承接（18 断言，随 npm test）。窗口形态：Tauri 下 windowManager.openReaderWindow 开独立 WebviewWindow（label reader-*，url=index.html?reader=1&…，main.tsx 路由到 ReaderApp，再经 doc_read 命令拉正文，避免大文本进 URL）；非 Tauri/失败回退 CustomEvent→应用内浮层 ReaderOverlay，保证浏览器预览可见。编码探测放 Rust（decode_text：BOM→UTF-8→chardetng/GB18030）最稳。阅读器主题（浅/纸/暗）、字号(60–150%)、按 docKey 的阅读进度均持久化 localStorage，独立于白板主题 |

| ADR-027 | 阅读器跟随软件主体主题（取消阅读器独立主题）+ 阅读体验增强（双页/连续/全屏/猜测渲染） | 用户反馈：阅读界面 title 与主题应与软件主体一致；深色下白板侧栏发白（根因：--bg-chrome-2 及 --chrome-grad-* 定义在 ":root, [data-theme=light]" 组合选择器，裸 :root 泛匹配使浅色薄荷值泄漏到 dark/paper——已在两主题块显式覆盖）。① 阅读器不再自带 data-reader-theme/主题选择器，reader.css 全部改用主体 token；独立窗口 ReaderApp 读同一 localStorage 设置 applySettings 同步主题，窗口标题统一为「文档名 — 脉络 Lumen」。② 关联文档在 NodePanel 以「预览方卡」呈现（DocPreview：真实 markdown 缩略渲染 + KaTeX + 底部渐隐，点开进阅读器）。③ 猜测渲染：engine.preprocessGuessMath 把「无 $ 分界符但明显是数学（含 \命令 或 ^/_ 上下标）」的行内片段自动包成公式，跳过代码/已有公式区；由设置开关 Settings.guessMath 控制（默认关）。④ 阅读体验：连续滚动 / 双页（CSS 多栏横向铺排、页间无缝、左下角页码、翻页按钮、竖滚轮转横向）/ 全屏（Fullscreen API）。阅读进度按模式分别记忆横/纵比例 |

| ADR-028 | 公式定界符归一化 + 猜测渲染默认开启 + 阅读窗自绘标题栏 + 设置滚动修复 | 用户反馈四点：①「渲染预览」应是关联文档的内容预览而非节点标题的另建小框——删除 NodeRenderPreview，只保留 DocPreview，且放大字号（scale 0.75、14.5px、高 172px）确保可读。②公式变红不渲染：根因是 GPT/LaTeX 正文常用 `\(…\)`/`\[…\]` 定界符，旧引擎只认 `$`，未转换的 `\(` 残留又被猜测渲染裹入 → KaTeX 解析失败标红。修复：新增 `normalizeMathDelims`（始终执行，`\(`→`$`、`\[`→块级 `$$`，跳过代码围栏与行内代码），`renderMarkdown` 先归一化再按需 `preprocessGuessMath`。同时扩充 `looksLikeMath`（绝对值 \|x\|、关系链 a<b、函数/导数 f'(x)、含运算算式），并**默认开启**猜测渲染（`DEFAULT_SETTINGS.guessMath=true`，settings KEY→v2）。③阅读窗口开头仍是 Windows 原生标题栏：`windowManager` 改 `decorations:false`+`titleBarStyle:'overlay'`，`ReaderView` 独立模式自绘可拖拽标题栏（`data-tauri-drag-region`；macOS 留红绿灯位、Windows 自绘三键），跟随软件主体。④设置面板滚动条左圆右尖、且标题/关闭键随滚动消失：卡片改 flex 列，头部固定，新增 `.settings-body` 独立滚动并统一圆角自定义滚动条（webkit + Firefox）。 |

| ADR-029 | 已开阅读窗前置 + PDF 式双页 + 目录/块级公式渲染修复 | 用户反馈三点：①再次点击已打开的文档，后台/最小化的阅读窗不前置（只 setFocus 不可靠），用户以为没反应。改为 unminimize→show→setAlwaysOnTop(true)→setFocus→300ms 取消置顶，并补齐 window 权限（unminimize/is-minimized/show/set-focus/set-always-on-top）。②双页逻辑不对：之前是横向多栏可滚动（像「往后面滑」）。改成 PDF 阅读器式——左右两页铺满整屏、向「下一跨页」翻：CSS 多栏按视口高度切列，两列为一个跨页，用 flow 的 transform 平移切换 spread，视口 overflow:hidden 不产生横向滚动条；滚轮带阈值+锁翻页、方向键/PageUp/Down/空格翻页，中缝分隔线+左右页码+居中页码条。③公式仍变红/不渲染的两个真因：(a) 目录 TOC 只存标题纯文本（含 `$…$`），从不渲染——给 `TocItem` 增 `html` 字段（用 `md.renderInline` 渲染标题内联，含公式占位），ReaderView 用 dangerouslySetInnerHTML 渲染 TOC 并对其调用 `typesetMath`；(b) 开了 guessMath 后，多行 `$$…$$` 块内那一行被当普通文本又包了一层 `$`，产生非法 TeX 被 KaTeX 标红——`preprocessGuessMath` 增加 `inMathBlock` 跟踪（按未转义 `$$` 计数进出块），块内原样保留。 |

| ADR-030 | 节点面板文档区独立滚动 + 双页改「竖向滚动的分栏纸页」 | 用户反馈两点：①关联文档预览卡把节点面板上方的「概括标题/完整问题」文本框挤到很小。改：NodePanel 拆为 `.np-top`（标题/问题/颜色，`flex:0 0 auto` 自然高度）与 `.np-docs-section`（`flex:1 1 auto`，内部 `.np-doc-grid` 独立 `overflow-y:auto` + 圆角滚动条），`.np-body` 自身 `overflow:hidden` 不再整面板滚动——上半区固定、文档区单独往下翻。②双页方向仍不对（之前做成左右横向翻跨页）。用户要的是：竖向连续滚动的一张张“纸”，每张纸中缝分左右两栏，正文按「左栏从上到下→右栏→下一张纸」顺序排。改：ReaderView 用 JS `paginate()` 分页——隐藏的 `.reader-content` 作测量源，按列宽量各顶层块高度，贪心塞进列高=视口的一列列，每两列拼成一张 `.reader-sheet`（左栏 + `.reader-sheet-gutter` 中缝线 + 右栏，白卡+阴影像 PDF 页），竖直堆叠在 `.reader-pages`；`.reader-body` 竖向滚动即翻纸。翻页按钮/页码条改竖直（`scrollBy top`），目录跳转定位到目标所在 sheet 的 `offsetTop`；窗口尺寸/字号变化时把纸页块搬回测量源重新分页。撤销 ADR-029 里横向 transform 翻页方案。 |

| ADR-031 | 阅读模式重定义为「单页/双页」+ 双页改真·PDF 双页连续 + 目录可收起 | 用户反馈：①选项应是「单页 / 双页」而非「连续 / 双页」，两者都连续滚动——`ReaderMode` 改 `'single' \| 'double'`（prefs KEY v3，兼容旧值）。②单页不应把内容局促在屏幕中央，要充分利用整宽：去掉 820px 居中限制，`.reader.is-single .reader-content` max-width:none、内边距 `clamp(24px,6vw,96px)`，窗口拉大/全屏时铺满左右。③双页之前被截成固定高 A4 卡片、且卡片 `overflow:hidden` 会把跨页的公式/段落截一半——错。改为真·PDF 双页连续：`paginate()` 用真实布局把顶层块逐个装进「页高≈视口高」的页，块溢出则整块退回另起一页（块不拆分、页尾留白，绝不截断公式/段落）；每两页拼成一行 `.reader-sheet`（`.reader-page` 左 + 中缝 + 右，白卡阴影像 PDF 页），纸行竖直堆叠、向下连续滚动；末尾落单页配虚线占位保持左右对齐。翻页/页码条竖直翻，尺寸/字号/全屏变化时把块搬回测量源重排。④目录支持收起：`ReaderPrefs.tocCollapsed` + 顶栏最左收起/展开按钮。⑤目录里无分界符的猜测公式与正文一致渲染（TOC `md.renderInline` 占位 + `typesetMath`，承 ADR-029）。撤销 ADR-030 的「竖向分栏纸页（单张纸内左右两栏、按列高切）」方案。 |

| ADR-032 | 修下标误判标红 + 双页显示宽==测量宽(放大不溢出) + 双页默认铺满/可调页面大小/收紧间距 | 用户反馈四点：①`斜向_TS_模态` 里 `_TS_` 被 guessMath 当公式包成 `$_TS_$` 导致 KaTeX 标红——`looksLikeMath` 上下标规则收紧为「底数 + `^`/`_` + `{…}` 或 单个字母数字(其后不接字母)」，排除前导下划线强调、`snake_case`、`hello_world`，而 `x_1`/`a_{ij}`/`10^{-3}` 仍识别。②双页放大字号时右侧内容溢出画框——根因是测量列宽 `colW` 与实际显示页宽不一致（页用 `flex:1 1 0; max-width:900px`）。改为显示页宽严格 = 测量宽（`colW + 2*PAGE_PAD_X`，`.reader-page` 用 `flex:0 0 auto` + JS 定宽），字号变化触发重排，绝不溢出。③双页默认应按宽铺满且左右不留大片空白——新增 `ReaderPrefs.pageScale`（60–100，默认 100=铺满），跨页总宽 = 可用宽 × pageScale，顶栏双页时提供「页面大小 –/＋」控件（像常见阅读器那样调显示页面大小，不只是字号）。④页与页/纸行间距过大——中缝 `GAP` 40→16、纸行间距 `SHEET_GAP` 24→12、页内边距 40→30/32、`.reader-pages` 外边距收紧、阴影与圆角减小，默认更紧凑铺满。 |

| ADR-033 | 进入 M5：AI Provider 抽象走「纯逻辑前端 + Rust 传输」，OpenAI 兼容优先；PDF 调系统程序打开 | 决策固化：O-3 选 **OpenAI 兼容优先**（baseURL + API Key，可接官方或任意兼容网关如 DeepSeek/Kimi/本地代理），Provider 抽象保留 `kind` 字段预留 anthropic/ollama；O-4 选 **PDF 点击 = 交系统默认程序打开**，不在应用内嵌 pdf.js（体积与复杂度更低，且系统阅读器体验足够）。架构上为守 DESIGN「前端零网络能力」安全边界，AI 请求的**构造与 SSE 解析放前端纯函数**（`src/ai/provider.ts`，全单测），而真正的 HTTP 流式传输下一轮放 Rust 命令 `ai_chat_stream`（reqwest + 事件回传 + 可中断）。上下文采用 outline-first（`buildBoardOutline`：节点清单 + 连线关系，文档正文按需再取）以应对 R-3 长白板超限；系统提示词受 `shareBoard` 隐私开关约束。`open_doc_external` 命令复用 storage 的 `safe_id`/`safe_doc_name` 做路径校验，用系统命令（explorer/open/xdg-open）拉起，无需新增插件或权限。 |
| ADR-034 | M5-1/M5-2：AI 对话窗 + 流式传输走 Rust，前端只解析 | 落实 M5 的传输与 UI。**传输**：`ai_chat_stream`（async Rust 命令）用 reqwest `bytes_stream()` 流式读取 OpenAI 兼容响应，把原始字节块经 `ai://chunk` 事件回传给发起窗口，前端用已单测的 `parseSseChunk` 增量解析；`ai://done`/`ai://error` 收敛；`ai_cancel` 通过全局 `CANCELLED` 集合置位、流循环检测到即中断。**为何前端不直接 fetch**：守 DESIGN「前端零网络能力」边界——密钥与请求集中在 Rust，前端只做纯逻辑；浏览器预览下用 fetch+ReadableStream 回退仅为开发便利。**窗口**：AI 对话复用阅读窗口范式（`WebviewWindow` + `index.html?ai=1` → main.tsx 渲染 `AiApp`），窗口绑定当前 project/board，`AiApp` 拉取白板 outline 作系统上下文；`capabilities.windows` 加 `ai-*`。**UI**：`AiChat` 流式气泡 + 打字动画 + 停止按钮，回答复用 M4 的 `renderMarkdown`+`typesetMath`（Markdown+KaTeX），内嵌 AI 设置表单（baseURL/Key/模型/温度/白板共享开关）。`AiFab` 悬浮按钮绑定当前白板；非 Tauri/开窗失败回退应用内浮层。依赖 reqwest 用 rustls-tls（免系统 OpenSSL，跨平台一致）。 |
| ADR-035 | M5-3：白板工具调用用 OpenAI function calling + 前端 agentic 循环 | 让 AI 不止依赖打开时注入的 outline，而能主动查阅白板。四个工具（`read_board_outline`/`list_nodes`/`read_node_doc`/`search_board`）以 OpenAI 兼容 function calling 暴露；工具定义是纯数据，执行器 `executeTool` 通过注入的 `ToolContext`（board + 异步 `readDoc`）访问数据，因此可脱离 Tauri 单测。**循环放前端**：`streamChatAgentic` 在收到 `finish_reason='tool_calls'` 时本地执行工具、把结果作为 `tool` 角色消息回填，再发起下一轮，直到普通回答或达 5 轮上限——比在 Rust 里做循环更易复用纯逻辑与测试，且传输仍走 `ai_chat_stream`（守边界）。流式解析升级为 `parseSseChunkRich`（同时抽 content / tool_calls 增量 / finish_reason）+ `accumulateToolCalls`（按 index 拼接分片 arguments）。隐私：仅当 `shareBoard` 开启且白板已加载时注入 `toolCtx`，否则 AI 无法读取白板。UI 用"正在查阅…"状态提示工具调用过程。 |
| ADR-036 | M5-6：节点引用回链——[[node:id]] 两级保护 + 显示标题胶囊 + 点击跳白板高亮 | AI 回答里用 `[[node:id]]` 引用节点，但直接交给 markdown-it 会被下划线/`^`/`_` 当成斜体/强调/下标破坏（id 糊成斜体乱码），且显示 id 代号对用户无意义。仿公式的「两级保护」：渲染前 `maskNodeRefs` 把 `[[node:id]]` 换成 markdown 与 KaTeX 都不会改动的占位 token（`LUMENNODEREF{i}X`，纯字母数字无下划线），渲染后 `unmaskNodeRefs` 换成显示**节点标题**的可点击胶囊（`<a.node-ref data-node-id>`＋图标）。点击经事件委托 → `jumpToNode`：Tauri 下向所有窗口 `emit('lumen://jump-node')` 并抬起 main 窗口，浏览器回退 CustomEvent；`App` 监听后切到目标项目/白板并以 `focusNode{id,nonce}` 通知 `BoardCanvas` 把该节点居中（视口中心，zoom≥0.8）＋选中＋闪烁脉冲高亮（`nonce` 保证重复点击同一节点也重新触发；`motion-off` 降级无动画）。系统提示词额外要求 AI 不要把裸 id 写进正文或表格单元格（表格里只写标题），避免破坏表格结构。 |
| ADR-037 | AI 回答渲染关闭 guessMath（修表格/加粗被当公式搅烂） | 现象：AI 回答里的表格渲染成 `∣−−−∣`、加粗 `**` 变 `∗∗`、注入的节点胶囊 `<a class=` 变 `&lt;a class=`。根因是 `AiChat.MessageBody` 复用了阅读器的 `renderMarkdown(guessMath:true)`——`guessMath` 是给**导入文档**（作者常省略 `$` 分界符）设计的猜测启发式，会把「看起来像数学」的裸片段自动包 `$…$`；但它对 AI 输出的**规范 markdown** 是有害的：GFM 表格分隔行 `|---|---|` 命中 `looksLikeMath` 的绝对值/竖线规则被当成行内公式，加粗 `**` 落入公式区后被 KaTeX 当乘号星号，导致整段结构崩坏。决策：**AI 回答一律 `guessMath:false`**。AI 需要公式时会自己写标准 `$…$`/`$$…$$`，而 `renderMarkdown` 始终执行的 `normalizeMathDelims` 仍会把 `\(\)`/`\[\]` 归一化，故公式能力不受影响。以 `src/ai/aiRender.test.ts` 固化「表格/加粗/节点引用/公式」四类回归。区分原则：**导入文档用 guessMath（内容不可控、常缺分界符），模型输出不用（本就规范）**。 |
| ADR-042 | 原生拖放坐标按平台分叉：新增纯逻辑 `src/canvas/dropPoint.ts`，并支持拖到「问题节点面板」导入 | 现象：Mac 端「拖 .md 到节点导入」完全没反应，Windows 正常。查源码定位到**跨平台口径不一致**：`tauri://drag-drop` 的 `position` 契约是 `PhysicalPosition`（tauri-runtime/window.rs:103），wry 的 Windows 后端（webview2/drag_drop.rs:167,184）确实上报物理像素，但 macOS 后端（wkwebview/drag_drop.rs:42 `(dl.x, frame.size.height - dl.y)`，NSPoint/NSRect 以「点」计）上报的是**逻辑点**；tauri-runtime-wry（lib.rs:4872）对两者都 `PhysicalPosition::new(x, y)` 原样透传、不做缩放。旧代码一律除以 `devicePixelRatio`，Retina(dpr=2) 上坐标被砍半，命中测试全部落空。**决策**：① 抽出纯函数 `dropPointToClient(raw, {isMac, dpr, viewportW, viewportH})`，macOS 不除 dpr、其他平台除，并保留一层「主口径算出视口外、另一口径落在视口内则自动切换」的兜底（防 navigator 平台探测失灵时整块功能失灵）；配 11 个单测固化各平台/dpr 组合，升级 tauri 后若上游修正可立刻发现。② 命中判定顺序改为「先判 `.node-panel`（position:fixed 浮在最上层，命中则视为落到面板当前节点）→ 再判画布节点」，满足「拖到节点或问题节点面板上都能导入」的诉求。**结论：Windows 端源码核对后确认无需改动**（ScreenToClient 给的就是物理像素，除以 dpr 正确）。 |
| ADR-041 | 浮动节点面板的坐标系统一为「视口坐标」：`.node-panel.is-floating` 改用 `position:fixed` | 用户报两个 bug：① 展开「项目/白板」侧栏时，节点面板被挤出可视区；② 按住面板标题栏起拖时，面板突然下移一截。根因是**坐标系串味**：面板是 `.board-canvas` 内的 `position:absolute`，但 `style.left/top` 写的是 `getBoundingClientRect()` 的**视口坐标**。于是 ① 侧栏展开让画布左边界右移 224/448px（`.sidebar` 宽 0→224/448），面板随容器一起被推出屏幕；② 画布上方还有 44px 标题栏，起拖时 `base.top` 实测为「容器偏移 + 原 rect.top」，写入后又被叠加一次偏移，于是每次起拖都往下跳一个标题栏高度。决策：**浮动态改用 `position:fixed`**，测量口径与写入口径统一为视口，面板位置与侧栏/画布彻底解耦。前置核查：祖先链 `.workspace` / `.board-surface` / `.board-canvas` 均无 transform/filter/backdrop-filter/contain，不会给 fixed 造成新的定位基准（`.titlebar` 与 `.sidebar` 的 backdrop-filter 是兄弟节点，不构成影响）。配套四件事：① 首次测量即 `clamp`（历史 localStorage 值可能来自旧错位口径）；② 监听 `resize` 重新夹紧，窗口/可视区变小也不会跑出屏幕；③ `.np-head` 提层（`position:relative` + `z-index:6`）盖住顶边 `np-resize-n` 拉伸条，避免按住标题栏上沿时误触发「从顶边缩小」；④ 四角手柄 `z-index:7` 保留拉伸能力，并新增「双击标题栏复位到默认停靠位」作为位置错乱时的逃生口。 |
