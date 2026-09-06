# 进度状态（唯一权威）

> **开工前先读本文件；每完成一件事就更新本文件。**
> 本文件只记录「进度」。计划与任务清单见 [PLAN.md](./PLAN.md)，设计与决策见 [DESIGN.md](./DESIGN.md)。

**最后更新**：2026-09-06 19:55（Asia/Shanghai）

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

## 二、已完成

| 事项 | 验证情况 |
| --- | --- |
| 设计文档 v0.2（含 §11 跨平台与发布策略、ADR-001~010） | — |
| 进度规划（M0–M7、任务看板、9 项风险） | — |
| MCP 环境：白名单加 `cargo`/`rustc`/`rustup`，超时 900s | `cargo 1.95.0` / `rustc 1.95.0` 实测通过 |
| 密钥防线：`.local/` + `.gitignore` + 扫描脚本 | **负向测试通过**：注入假 `sk-` 密钥被正确拦截（退出码 1） |
| 仓库骨架 24 文件（前端 + `src-tauri` + CI + 文档） | `npm install` 成功；`npm run build` 成功（tsc + vite 6.4.3，29 模块） |
| Git 初始化并提交（`38482ce`），远端已配置 | 工作区干净，24 文件，无垃圾文件 |

## 三、进行中

- 无（等待推送与首次运行的确认）

## 四、等待用户执行

| 事项 | 命令 | 为何我无法代劳 |
| --- | --- | --- |
| 推送到 GitHub | `git push -u origin main` | 需要本机浏览器鉴权 |
| 首次运行应用 | `npm run tauri:dev` | 需要 GUI；首次 Rust 编译 5–15 分钟 |

## 五、下一步（接下来我做的）

1. **M1-3 BoardRepository**（Rust）：目录结构读写 + 原子写（临时文件 + rename）
2. **M1-4 设置**：存储根目录选择与迁移
3. **M1-5** 项目 CRUD + 白板 CRUD 最小可用 UI

## 六、阻塞项

- **推送未执行**：提交 `38482ce` 仍在本地，远端 `main` 为空。推送前无法验证 CI 工作流。

## 七、待定问题（不阻塞当前工作）

| ID | 问题 | 何时需要定 |
| --- | --- | --- |
| O-3 | AI 供应商与鉴权方式（OpenAI 兼容 / Anthropic / 本地 Ollama） | M5 前 |
| O-4 | 「点击 PDF」的确切语义（是泛指文档，还是确指 PDF） | M4 前 |
| O-5 | 结构自由度（图存树显 / 强制严格树） | M3 前 |
| O-6 | 是否支持直接导入 ChatGPT 导出 JSON | M6 后 |

## 八、踩过的坑（避免重犯）

| 坑 | 说明 |
| --- | --- |
| `"type": "module"` | 仓库内 `.js` 脚本必须写 ESM；用 `require` 会静默失败——曾因此把临时文件误提交，靠 amend 在推送前修掉 |
| TS6310 | `composite` 项目不可设 `noEmit`；已改为单一 tsconfig + `@types/node` |
| MCP 无法直接 spawn npm | 本机 npm 是 `npm.ps1`，须经 `powershell -File` 包装执行 |
| 首次提交前 `git show HEAD:` 必失败 | 扫描脚本已静默 stderr，避免噪音 |
| MCP 配置改动不生效 | 只换隧道不重启 `server.mjs` 时，`config.json` 的改动不会重新读取 |
