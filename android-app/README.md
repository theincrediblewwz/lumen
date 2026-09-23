# Lumen Android 预览版

这是与 Lumen 桌面端同仓库的 Android 客户端，基于 LearnStuffQuickly 既有的 Expo SDK 54 / React Native 0.81 / SQLite 实现。当前版本为 `2.1.0-preview.3`、Android versionCode 18。应用身份仍是 `com.learnstuffquickly.app`，启动器显示 LearnStuff；现有同签名安装可保留数据。

下载安装、调试签名的升级边界和跨设备同步说明见 [Android 预览版说明](../docs/ANDROID-PREVIEW.md)。这份公开源码只包含客户端，未包含独立 Gateway 服务；用户可在应用内配置自己的兼容 AI 服务，未配置时不会悄悄发送真实请求。

## 本地开发

需要 Node 20.19+、Android SDK 与 Java 17。项目包含一个本地 Expo 原生模块，使用 Android 原生选择菜单；测试最终 APK 时需要原生构建，Expo Go 不包含该模块。

```bash
cd android-app
npm ci
npm run typecheck
npm run lint
npm run test:contracts
npx expo run:android
```

`.env.example` 中的 Gateway URL 默认留空。仓库不包含旧版独立 Gateway 服务，因此依赖该服务的历史 HTTP 集成脚本不列入上述本地检查；合同测试不调用真实服务。个人 API Key 和 WebDAV 密码只能由用户在应用中配置，不进入源码或构建环境。

## 学习流程

- 近白色白板显示节点和关系；点击节点才出现阅读、讨论及更多操作。
- 节点挂载 Markdown 文档，支持目录、公式和阅读位置。
- 阅读时长按文字可解释、举例或追问；公式和跨段内容用“引用段落”。问题发送前可检查上下文。
- 持续讨论可选单条、多条或全部完成消息，把原文保存成 Markdown 文档和新节点；引用可回到来源。
- 本地导入、便携导出、备份和显式配置的 WebDAV 同步继续可用。

真实 WebDAV 服务、Mac 与物理手机的联调尚未完成；公开预览的自动化测试不能替代这些验收。详细边界见 [交付说明](../docs/ANDROID-PREVIEW.md)。
