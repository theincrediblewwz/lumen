# Android 融合与跨端同步预览

2026-09-22；分支 `codex/android-sync`；基线 `cf3ed4f`。本次为用户批准的 Android / Windows / macOS 共同协议适配，未发布、未推送、未打 tag。

## 已实现

- AI 回答可单独保存，或勾选多条消息 / 保存全部已完成消息；同一事务保存原会话、Markdown、节点、可选父连线和 `conversation_documents` 来源记录。共享幂等键 `chat:<conversationId>:<ordered message ids>`，文件名另用 SHA-256；Markdown 的回链可打开原会话。重复保存已同步的 Android 来源记录也复用节点。
- 设置中显式启用 WebDAV。HTTPS、独立 `lumen-sync-v1/<libraryId>/` 远端目录、OS 凭据库保存密码。主窗口打开且在前台时启动、每 30 秒以及恢复焦点/网络时重试；未开启不联网。
- 原始 Lumen 项目夹作为 `_lumen_project` 字段保留，每块白板对应安卓 `projects`；文档、节点、连线、多文档、对话、对话来源、阅读位置与原始附件按统一行协议同步。未知表与未知字段保留在 ledger。文件路径生成稳定文档 ID，Android 原有 ID 不重建。
- `.lumen-sync/ledger.json` 持久化协议 DAG、待发送队列、投影和原始 blob。先存队列再联网；哈希校验完成后才投影。已发布但未记账的重试验证原内容。
- 本地写入统一使用 Windows `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` / Unix rename；不先删除旧文件。多文件应用使用 before-image 日志，崩溃启动恢复、写到一半失败全部回滚；持久 committed 标记防止完成的事务被重启误回滚。命令层 IO 互斥，白板和对话另有磁盘 revision 检查。
- 网络请求阶段可继续编辑；应用远端变更前保存未完成编辑，完整库 CAS 不匹配时保留本地更改、留待下一轮。落盘成功后等主窗口完成刷新再恢复编辑，画布历史重建。
- 同内容并发保留多个版本；普通编辑只沿当前显示版本继续，必须在设置中选择才收敛。删除父实体 / 修改子实体等引用冲突保留当前投影和远端完整版本，可显式保留电脑版本；未选择前不级联删除。
- 远端删除的原文件留在磁盘并记为 retired，避免再次扫描时复活；协议历史仍保留删除前正文。阅读位置按 ratio 跨端近似恢复，原 Android anchor 保留。

## 验证与限制

测试使用合成资料与内存传输，无真实 Provider、WebDAV 账户或用户目录。桌面 fixture 已实际投影到 Android SQLite 后再回传，桌面再次投影 / 捕获验证全部已有字段不丢失。前端 268 项测试（22 文件）通过，包含普通冲突分支、断网 outbox 重放和期间编辑的 CAS 保护；Rust 20 项测试通过，覆盖故障注入回滚、重启恢复、消息原文保护、跨端幂等键和预览目录搬移。类型检查、前端构建和密钥扫描通过。

桌面原生交互、真实 WebDAV 权限 / 兼容性、真实三端联调尚未完成；macOS 原生编译及实机验收需 Mac。后台退出后不继续同步。桌面当前一轮读取库限制 64 MiB，协议一提交最多 4 MiB / 5000 实体、每附件 32 MiB；超过限制保留本地和队列并报错，不拆开跨表事务。未实现历史压缩与远端垃圾清理。

安卓的来源切片、收藏、学习状态等扩展资料会完整保留与转发，但桌面未增加相应专属编辑界面。跨实体冲突提供保留本机当前版本，远端候选可在设置详情查看；复杂人工合并仍需后续界面。阅读位置暂用滚动比例近似 Android 块比例，非字级一致。

## 本地 Windows 预览

仓库既有规则原文：“**提交 ≠ 构建**：日常小步提交；macOS/Windows 构建只在里程碑打 tag 时触发”。本次按主任务明确安排做一次完成里程碑的本地预览构建，无安装器、无发布、无 tag/push。

`tauri build --debug --no-bundle --features isolated-preview --config <preview-config>` 使用独立 app identifier `com.lumen.sync.preview`；编译特性使配置固定在 exe 旁 `.preview/config`、系统凭据 service 为 `lumen.sync.preview`，隔离正式应用设置与密钥。合成资料初始化脚本为 `scripts/prepare-preview.ts`。不要以正式应用配置运行验收。

首次原生验收发现 WebView 的配置项 `dataDirectory` 没有使缓存实际落到预览目录：进程证据为 `C:\Users\Administrator\AppData\Local\com.lumen.sync.preview\EBWebView`。此缓存没有删除，首次运行不满足 E 盘缓存约束。修复后隔离预览先禁止主窗口自动创建，由 Rust `WebviewWindowBuilder::data_directory` 明确指定 exe 旁 `.preview/webview`；阅读与 AI 窗口同样走受限原生创建命令。修复编译通过不等同于实际路径已验收，须以新进程命令行复核。

首次关闭验收还发现缺少 `core:window:allow-destroy` 权限，Tauri 的 `onCloseRequested` 在异步回调成功后自动调用 destroy 因而被拒绝。现已补齐权限，关闭处理器只等待编辑落盘，失败时阻止关闭，不再递归请求 close；正常关闭行为仍须原生复测。

主任务已复测主窗口启动、响应、WebView 实际 E 盘路径及正常关闭：`desktop-launch-final.json` / `desktop-webview-isolation-final.json`，PID30512；不代表所有原生交互或三端同步通过。预览初始化配置现在写相对 `.preview/library`，仅 isolated-preview 在读取时按 exe 父目录解析，用户后续选择的绝对路径保持原样。最终交付须重新运行 `prepare-preview.ts` 生成合成库，不携带已运行的 WebView 缓存。

共享核心通过 `node scripts/vendor-sync-core.mjs <android-app/sync/core>` 更新；`src/sync/core-provenance.json` 包含每个文件 SHA-256。禁止手工修改桌面副本而不回写规范源。
