# 性能与体积基线（M7-5）

> 依据 [DESIGN.md §3](./DESIGN.md) 各性能验收标准建立基线。
> 分两类：**可自动测量**（前端产物体积——已记录实测值）与 **需实机压测**（FPS / 首屏 / 启动时间——列出方法与目标，待在真实构建产物上填写）。
>
> 最后更新：2026-09-08。

---

## 1. 前端产物体积（已实测）

`npm run build` 产出 `dist/`，实测：

| 项 | 大小 |
| --- | --- |
| `dist/` 总计 | **~1.79 MB**（1,837,231 B） |
| 主 JS `assets/index-*.js` | ~650 KB（含 React / markdown-it / KaTeX 逻辑） |
| 主 CSS `assets/index-*.css` | ~90 KB |
| KaTeX 字体（ttf/woff 合计） | ~0.5 MB（离线内置，FR-6.8） |

**结论**：前端体积健康。KaTeX 字体是主要静态资源，为满足「全部离线内置」必需。桌面安装包体积主要来自 WebView 运行时与 Rust 二进制，需在打包后（M7-1 产物）补测。

| 项 | 目标 | 实测 | 状态 |
| --- | --- | --- | --- |
| Windows NSIS `Lumen_0.1.0_x64-setup.exe` | 参考值 <10 MB | **4.26 MB**（4,255,751 B） | ✅ 达标 |
| Windows MSI `Lumen_0.1.0_x64_en-US.msi` | — | 5.65 MB（5,648,384 B） | ✅ |
| Windows 可执行 `lumen.exe`（release） | — | 14.0 MB（14,005,760 B） | ✅ |
| macOS arm64 .dmg `Lumen_0.1.0_aarch64.dmg` | 参考值 <15 MB（不含系统 WebView） | **5.38 MB**（5,640,397 B） | ✅ 达标 |
| macOS arm64 `Lumen_aarch64.app.tar.gz`（更新包） | — | 5.30 MB（5,561,660 B） | ✅ |

> Windows 打包实测（本机 `npm run tauri:build`，2026-09-08）：release 编译约 1m45s，产出 MSI + NSIS 两种安装包。安装包体积远低于目标，得益于 Tauri 复用系统 WebView2（无需内嵌 Chromium）。
>
> Release `v0.1.0`（GitHub Actions，2026-09-08 已 Publish）产物实测：macOS aarch64 dmg **5.38 MB**、Windows NSIS setup **4.04 MB**、MSI **5.34 MB**（CI 构建体积与本机略有差异，均远低于目标）。macOS 一期为 ad-hoc 未签名，首次打开需右键「打开」绕过 Gatekeeper。

---

## 2. 画布性能（需实机压测）

### 方法
用示例数据生成脚本 `scripts/gen_sample_board.mjs` 生成大规模白板（或临时改参数扩到目标量级），在打包产物中打开，用浏览器/WebView 性能面板或帧计观察。

| 编号 | 场景 | 目标 | 实测 | 状态 |
| --- | --- | --- | --- | --- |
| FR-2 | 500 节点 / 2000 连线，平移 + 缩放 | ≥55 FPS | — | ⏳ |
| FR-4 | 1000 连线，拖动目标节点 | 无卡顿（≥55 FPS） | — | ⏳ |

### 已有优化（支撑达标）
- 连线拖拽期降级为直线，停止后恢复贝塞尔（避免每帧重算路径）。
- 视口裁剪：`visibleWorldRect` / `isVisible` 支持只渲染可见节点（按需启用）。
- 节点层 DOM + 连线层 SVG 分离，`transform: translate3d` 走合成层。

---

## 3. 阅读窗口性能（需实机压测）

| 编号 | 场景 | 目标 | 实测 | 状态 |
| --- | --- | --- | --- | --- |
| FR-6.2 | 400 KB 含数百公式文档 | 首屏 <500 ms | — | ⏳ |
| FR-6.2 | 同上，连续滚动 | 不掉帧 | — | ⏳ |

### 已有优化
- **分批排版**：先排当前视口，空闲帧排其余，长文档不阻塞滚动（reader/engine，41 测试覆盖）。
- 阅读进度记忆在公式排版完成后二次校准，避免高度漂移。

---

## 4. 启动时间（需实机）

| 项 | 目标 | 实测 | 状态 |
| --- | --- | --- | --- |
| 冷启动到可交互 | 参考值 <2 s | — | ⏳ 待实机计时 |

---

## 汇总

- **已达标 / 已实测**：前端产物体积（~1.79 MB）；**Windows 安装包体积（本机 NSIS 4.26 MB / MSI 5.65 MB；CI Release NSIS 4.04 MB / MSI 5.34 MB）**；**macOS arm64 dmg 5.38 MB**（CI Release，均达标）。
- **待实机填写**：冷启动时间、画布 FPS 压测、阅读窗首屏。
- 压测数据回填后，如任一项不达标，记录瓶颈并在 `docs/STATUS.md` 开跟进项。


