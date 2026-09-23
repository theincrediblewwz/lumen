# Lumen Android 2.1.0-preview.3

这是与桌面 Lumen 同仓库的 **Android 预览版**。下载入口：[GitHub Release](https://github.com/theincrediblewwz/lumen/releases/tag/android-v2.1.0-preview.3)。APK 支持 Android 7.0 及以上，包含 arm64-v8a 和 x86_64，应用包名 `com.learnstuffquickly.app`、versionCode 18。启动器暂显示 LearnStuff，以延续原 Android 客户端的应用身份。

## 安装和数据

APK 使用 Android 调试证书签名，供公开预览体验，并非应用商店正式签名。安装系统会核验签名；它只能原位更新 **相同包名且相同证书** 的预览版。若现有安装的证书不同，先在旧版中完整备份并验证备份可读，再卸载旧版、安装此包并恢复。卸载可能移除应用私有 SQLite 数据，不能先卸载再寻找备份。将来切换正式签名时也必须先完成备份迁移方案。

下载后可对照 Release 附带的 `SHA256SUMS.txt` 验证 APK。包内没有个人 API Key、WebDAV 密码或预置同步服务。打开应用后可先离线使用白板、文档和原文保存；需要真实 AI 或同步时，由用户分别在本机配置服务与凭据。选择文字或打开问题草稿不会自动发送。

## Android 学习流程

在白板点选节点，按需打开文档或讨论。长按文档文字可用系统菜单“解释 / 举例 / 追问”；公式和多个段落通过阅读页“··· → 引用段落”选择。讨论发送前展示有界上下文。所引原文和来源链接随消息保存；保存对话为文档与新节点后，仍能回到来源。原文已改写或有重复候选时，应用保留引用快照并说明无法精确定位。

跨设备采用 Android/桌面共享的版本化 WebDAV 协议，用户自行提供 HTTPS WebDAV/Nextcloud 服务。客户端具备离线队列、冲突保留和恢复逻辑；**真实三端 WebDAV、Mac 原生以及物理 Android 后台验收尚未完成**。使用真实资料之前，先在各端做完整备份，并用独立合成资料试连和恢复。

## 源码、验证和版本关系

- Android 源码：[android-app](../android-app/README.md)；桌面源码仍在 `src/` 和 `src-tauri/`。五个共享同步核心文件在当前 Git 内容中一致，`src/sync/core-provenance.json` 记录摘要。
- Android 源码来自 LearnStuffQuickly 提交 `52ddd8313e28168cc39a5a6adf4b86c8432736c9`，只复制了已跟踪文件。桌面同步适配来自 Lumen 提交 `875440d5f660214dd2ef9934fb712f701b3292de`。
- Android 原提交通过 220/220 合同测试、typecheck、lint、release APK 构建/签名与 Android 15 合成数据模拟器流程。Lumen 桌面适配此前通过 268 项前端测试、20 项 Rust 测试及源码构建；本次仓库 CI 会分别运行两端的非设备检查。
- APK 是原 Android 提交对应的已验证二进制；公开仓库的改动限文档、CI、示例环境、合成测试字符串和依赖独立私有 Gateway 的旧开发脚本，不改变应用运行代码或构建设置。
- `android-v*` 是 Android 标签，不触发原有 `v*` 桌面发布工作流。正式桌面版仍见 [v0.1.8](https://github.com/theincrediblewwz/lumen/releases/tag/v0.1.8)。

原始 Android 模拟器证据和本地交付包位于开发机的独立验收目录，不包含在公开仓库或 APK 中。公开 Release 给出源码提交、安装包、包元数据、校验和与验证边界。
