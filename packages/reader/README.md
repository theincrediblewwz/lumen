# packages/reader —— 阅读内核（M4 落地）

本目录用于承载 **mdread** 的渲染内核，作为「脉络」的独立阅读窗口（FR-6）。

计划迁移的内容（来自同级 Android 项目 `mdread/app/src/main/assets/reader/`）：

| 文件 | 作用 |
| --- | --- |
| `engine.js` | markdown-it 定制规则：块级/行内公式两级保护、标题锚点 slug、目录收集（纯函数，可单测） |
| `reader.js` | 控制层：一次性上屏 + KaTeX 按视口/空闲帧分批排版 |
| `reader.css` | 三主题变量（与本项目 `src/styles.css` 的 token 对齐） |
| `markdown-it.min.js` | vendor（MIT） |
| `katex/` | vendor（MIT），含字体 |

同迁的还有回归套件 `check_offline.js` / `check_tocpage.js`，将挂入 `npm run check`，
作为公式渲染的长期防线（M4-2）。

> 迁移时**不得减少**原有断言数量。
