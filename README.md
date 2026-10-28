# 脉络（Lumen）

> **本地优先的极简白板，把 AI 辅助学习的过程结构化为「问题树」。**
> 每个节点是一个你问过的问题，每条连线是一次思维的延伸，每篇文档是一次 AI 回答的原文。

## 当前版本

[下载 Mac 0.1.14](https://github.com/theincrediblewwz/lumen/releases/tag/mac-v0.1.14) · [升级与恢复说明](./docs/LONG_MARKDOWN_AND_FAITHFUL_IMPORT.md)

桌面源码 **0.1.14**，技术栈 Tauri 2 + React 18 + TypeScript + Vite。最新更新包括长 Markdown 顺序分批分析、上游临时满载自动重试，以及两种对话导入方式：

- **AI 重构图谱**：按主题重新组织问题树，各批结果在本机合并。
- **忠实逐轮图谱**：每条 AI 回答保留为一个节点；新 AI 只生成概括标题、简短导读和建议层级，原回答由本机逐字保留。支持分享对话、明确问答标题和“第 N 条回答”导出；长回答分片分析后仍保留为同一节点。

两种方式都先预览、再确认写入。失败或取消不写入部分结果，完整原文与轮次选择依据随资料保留。详细说明见 [导入、升级与恢复](./docs/LONG_MARKDOWN_AND_FAITHFUL_IMPORT.md)。已有知识库、PDF/图文资料、白板工具、会话历史与资料包恢复功能继续保留。

## Android 预览版

Android 源码同步至 **2.1.0-preview.8 / versionCode 23**，包名仍为 `com.learnstuffquickly.app`，图标名称仍为 LearnStuff。包含节点 PDF/图文原件、阅读、讨论与划词提问、知识交换、备份和 WebDAV 同步能力：[源码与开发说明](./android-app/README.md)。桌面 0.1.14 的两种对话导入界面属于桌面功能，本次没有宣称 Android 已提供同样的导入入口。

[旧公开 Android 预览 APK](https://github.com/theincrediblewwz/lumen/releases/tag/android-v2.1.0-preview.3) · [安装、签名和数据说明](./docs/ANDROID-PREVIEW.md)。旧公开附件保持不变，不能当作当前源码版本的安装包；新二进制以 [Releases](https://github.com/theincrediblewwz/lumen/releases) 的明确版本和校验和为准。真实 WebDAV 与物理设备行为须以对应版本的验收记录为准。

---

## 它解决什么问题

用 ChatGPT / Claude 做研究时，知识是**线性聊天流**，但思考是**树状分叉**的：

- 想复用前面某个回答，只能反复滚动找
- 导出成 Markdown 存文件夹后，信息变成一堆无结构的平铺文件
- 「这个问题从哪个问题分叉出来的」完全丢失——只留下一地树叶，看不到树

脉络把这三者重新组织起来：**白板画布 + 问题树 + 本地 Markdown 库 + 离线公式阅读器 + 白板感知的 AI 助手**。

## 核心概念

```
项目 Project  一门学问 / 一个长期方向（如「扩散模型」）
 └─ 白板 Board   一个研究主题（如「数学基础」）
     └─ 节点 Node    一个你问过的问题（如「什么是 ELBO？」）
         └─ 文档 Doc     一次 AI 导出的回答（.md，支持 .pdf 系统打开）
```

- **节点**：圆角方框包裹问题标题；悬停看简介，单击在右侧面板看 / 编辑全文
- **连线**：有向 = 追问 / 派生，无向 = 相关；可加标签、可自动整理成树
- **阅读窗口**：点击文档在**独立于白板**的窗口打开，完整渲染 Markdown 与 LaTeX 公式（Android 应用 **mdread** 的桌面移植）
- **AI 对话**：悬浮按钮展开，默认以当前白板为上下文，通过工具调用**按需读取**该白板的 Markdown 文件

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 白板画布 | 自研引擎：DOM 节点层 + SVG 贝塞尔连线层；平移 / 缩放 / 撤销重做 / 树状自动布局 |
| 内容与阅读 | Markdown 导入、离线 KaTeX 公式渲染、独立阅读窗（连续 / 单页 / 双页 / 全屏）、PDF 系统打开 |
| AI 助手 | OpenAI 兼容连接、多套模型设置、白板工具调用、节点引用回链、对话历史与凭据保护 |
| 对话导入 | AI 重构 / 忠实逐轮；长 Markdown 分批、进度与取消、临时满载重试、确认后写入 |
| 知识与原件 | 独立知识库、版本与出处、PDF/图文原件保留、项目/全库资料包恢复到新目录 |
| 全局搜索 | 跨全部白板全文检索（Mod + K），命中高亮、点击跳转 |
| 导出 | 白板导出 Markdown / HTML / SVG / PNG |
| 快照与恢复 | 打开白板自动留存、保留最近 20 份、恢复前自动保险 |
| 可访问性 | 平台感知快捷键体系、快捷键帮助（?）、三套主题、尊重 reduced-motion |

> 完整使用说明见 **[docs/USER_GUIDE.md](./docs/USER_GUIDE.md)**（含首次启动引导与快捷键表）。

## 快速开始（开发）

```bash
# 依赖：Node 24.15+、Rust 1.95+、Tauri 2.x 系统依赖
npm ci
npm run tauri:dev      # 启动桌面应用（开发模式）

# 常用校验
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run build          # tsc + vite build
npm run tauri:build    # 打包桌面应用（ad-hoc）
```

## 离线知识格式交换

仓库包含离线产品转换工具 `scripts/knowledge_exchange.py`，在知识文档格式与 Lumen 知识包之间生成独立副本；它不写入应用资料库，也不覆盖既有输出目录。锁定的公开 schema 位于 `contracts/historyandknowledge/`，来源提交和 SHA-256 在该目录的 `SOURCE.json` 中核验。

需要 **Python 3.11+**，并安装锁定的 `PyYAML` 与 `jsonschema`。以下命令将环境与缓存留在本仓库：

```bash
python3 -m venv .local/knowledge-exchange-venv
.local/knowledge-exchange-venv/bin/python -m pip install --cache-dir .local/cache/pip -r scripts/knowledge-exchange-requirements.txt
.local/knowledge-exchange-venv/bin/python -B scripts/knowledge_exchange.py --help
LSQ_EXCHANGE_PYTHON="$PWD/.local/knowledge-exchange-venv/bin/python" LSQ_EXCHANGE_QA="$PWD/.local/knowledge-exchange-tests" npm --prefix android-app run test:knowledge-exchange
```

Windows 将上述虚拟环境解释器路径改为 `.local/knowledge-exchange-venv/Scripts/python.exe`。安装依赖后，转换本身不需要网络、Gateway 或模型服务。跨端测试会实际经过 SQLite、副本导入、编辑和格式导出；它不能替代真实个人资料的备份核对。

## 数据存储

**文件即数据，不用数据库。** 你指定一个根目录，每块白板就是其中一个文件夹：

```
<你指定的目录>/
├── index.json
└── <项目>/
    ├── project.json
    └── <白板>/
        ├── board.json      # 节点、连线、树状结构、视口
        ├── docs/*.md       # 该白板的全部 Markdown 原文
        ├── chats.json      # AI 对话历史
        ├── exports/        # 导出产物
        └── .snapshots/     # 历史快照（最近 20 份）
```

好处：可用 Git 管理、可整体备份迁移、AI 直接读文件夹、软件卸载后数据仍在。

## 文档

| 文档 | 内容 |
| --- | --- |
| **[docs/STATUS.md](./docs/STATUS.md)** | **当前进度的唯一权威**：已定案决策、已完成、下一步、阻塞项、待定问题 |
| **[docs/USER_GUIDE.md](./docs/USER_GUIDE.md)** | 使用手册：首次启动引导、界面速览、快捷键表、AI / 导出 / 快照 / 数据管理 |
| [docs/DESIGN.md](./docs/DESIGN.md) | 设计文档：愿景、概念模型、功能需求（含验收标准）、视觉与动效规范、技术架构、数据模型、非功能需求、测试策略、ADR |
| [docs/PLAN.md](./docs/PLAN.md) | 进度规划：工程规范、M0–M7 里程碑、任务看板、风险登记（**只记计划，不记进度**） |

## 技术栈

| 环节 | 选型 |
| --- | --- |
| 外壳 | **Tauri 2.x**（Rust 后端 + 系统 WebView） |
| 前端 | React 18 + TypeScript + Vite + Zustand |
| 画布 | 自研：SVG 连线层 + DOM 节点层 |
| 渲染 | markdown-it 定制规则 + KaTeX（全部离线内置） |
| 存储 | 文件系统 + JSON（原子写、快照） |
| 测试 | Vitest（44个文件 / 457项测试）+ Rust 单测与合成界面验收 |

平台策略见 [DESIGN.md §11 跨平台与发布策略](./docs/DESIGN.md)。主目标平台 macOS(arm64)，Windows 次之。

## 路线图

| 阶段 | 目标 | 状态 |
| --- | --- | --- |
| M0 | 立项与文档 | ✅ |
| M1 | 骨架与存储层 | ✅ |
| M2 | 白板画布 v1 | ✅ |
| M3 | 连线与结构 | ✅ |
| M4 | 内容与阅读窗口（mdread PC 版） | ✅ |
| M5 | AI 对话 | ✅ |
| M6 | 打磨与增强（主题 / 搜索 / 导出 / 快照 / 快捷键） | ✅ |
| M7 | 发布（打包 / 端到端验收 / CI） | 🚧 进行中 |

详见 [docs/PLAN.md](./docs/PLAN.md)。
