# Roadmap

## M0 - Android-First Foundation

- Expo React Native TypeScript app.
- Provider presets and editable provider profiles.
- Manual custom provider and model ID entry.
- Platform-scoped API key handling: SecureStore on Android and current-tab session storage on Web.
- OpenAI-compatible model discovery.
- OpenAI-compatible chat completions.
- Image attachment path for image-capable chat models.
- Documentation for provider, adapter, plugin, and MCP boundaries.

## M1 - Real Provider Polish

- Dedicated Volcengine Ark adapter.
- Dedicated Alibaba Bailian adapter where compatible mode is insufficient.
- New API / One API relay compatibility checks.
- Streaming responses.
- Provider/model capability override UI.
- Conversation list and persistent chat sessions.

## M2 - Multimodal Depth

- Doubao/video-capable model adapter.
- Video upload/preprocessing pipeline.
- Attachment size warnings and compression controls.
- Audio input and transcription path.
- Per-message media inspection.

当前实现边界：图片、视频和文件选择 UI 已按模型能力启用；选择器已经实施数量、单项大小、总大小和图片像素上限。百炼兼容模式已支持有界的本地视频 `video_url`，OpenAI 官方 API 已支持显式 `file-input` 模型的文件附件，火山方舟已支持带参考素材的视频生成任务。其他服务商的对话视频上传/转码协议、自动压缩和音频链路仍未完成，因此 M2 不能仅凭已有入口视为整体完成。

`1.0.5` 本地候选已补齐本轮真机反馈对应的界面链路：待发送图片使用 1:1 方形真实预览；对话视频改为 `expo-video` 原生内嵌播放器和全屏控件；视频文件名与“保存/分享”位于不会被卡片裁切的独立操作区；Android 保存使用系统 Storage Access Framework，不申请宽泛媒体库权限。原生图片选择不再额外请求整张 Base64，以降低高分辨率图片进入 JS 堆时的峰值。

该候选还把 Android 键盘模式设为 `resize`，让聊天和改名对话框参与键盘避让；聊天页在设置页打开时保持挂载，设置页首次打开后复用，Android 使用较轻的按压/页面/消息呈现，并把候选模型按每批 60 条加载。以上属于已实现、已有静态/单元/Web 证据的修复，不代表 Android 真机已经验证。

## M3 - Plugins and MCP

- Remote MCP server manager.
- Tool permission prompts.
- Tool-call execution loop in chat.
- Plugin manifest installer from URL or local file.
- Plugin marketplace/import format for private use.

## M4 - Collaboration Handoff

- Android APK build pipeline.
- EAS or local Gradle build documentation.
- Test matrix for representative providers.
- Release checklist and signing notes.

当前状态：仓库已经定义 PR/Push 质量工作流，以及“精确 main tag -> owner draft -> main-only 隔离预检 -> 未签名构建 -> 正式 keystore 单签名 -> GitHub asset digest/uploader 校验 -> immutable Release -> Pages 公共更新清单与可信 `release.html` 下载页”的 CI 流程。Pages 只接受 owner 发布且由 Actions 上传资产的 Immutable Release，并在 APK 字节、GitHub digest 与对应校验文件全部匹配后公开下载页。首个正式签名的 stable `v1.0.4` 已完成 Release attestation、资产、证书指纹与匿名 Pages 下载验证；M4 的发布工程部分已闭环，剩余门槛是代表性真机流程和更广的真实服务商账号/媒体任务矩阵。

当前个人私有仓库在 GitHub Free、Pro 或 Team 方案下不能为 Environment 启用 required reviewers；私有仓库的 Environment secrets 与 deployment branch/tag 限制又至少需要 Pro/Team。个人私有仓库的直接 collaborator 没有 read 档；按维护者决定，`BlueOcean223` 保留为明确受信任的 write collaborator。owner-only main/tag Ruleset、main-only Environment 与 workflow actor gate 能把篡改降为 fail-closed，但不等价于双人审批，也不能消除 write collaborator 对 draft/Release 的拒绝服务风险。

2026-07-10 `1.0.5` 候选本机验证：`npm.cmd run check` 通过 15 个测试文件/249 个测试，TypeScript 与 ESLint 为零错误；Web export 通过（3131 modules、主 bundle 6.9 MB）；Expo Doctor 20/20，`expo install --check` 通过。390×844 浏览器回归覆盖聊天/设置、真实上传图片的方形待发送预览，以及设置与聊天连续切换 20 次，console 为 0 error；仅保留 React Native Web 的 `shadow*`/`pointerEvents` 两类弃用 warning。

干净 Expo prebuild 与未签名 `assembleRelease` 已通过。使用与正式 `v1.0.4` 相同证书签出的本地验收候选位于 `D:\EmbezzleStudio-Releases\v1.0.5-candidate\Embezzle-Studio-v1.0.5-candidate-release.apk`，大小 96,473,241 字节，SHA-256 `c390a116a592773f23626ac6b63ace40a881e710e61318eedd196c6c0d6b8bc7`。其包名为 `com.szdtzpj.embezzlestudio`，版本 `1.0.5`/code 5，minSdk 24/targetSdk 36；正式证书 SHA-256 为 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`，v2/v3 和 zipalign 通过，无 overlay/camera/microphone 权限。新增的 `ACCESS_NETWORK_STATE` 与 `WAKE_LOCK` 来自视频播放依赖。

浏览器和本地 APK 结构/签名证据都不能替代 Android 真机：键盘弹出后输入区是否始终可见、Seedance 视频的原生播放/全屏、Storage Access Framework 保存/取消/空间不足路径，以及设置与聊天连续切换是否仍会卡死或闪退，均待设备验收。当前仍无连接设备；这个 production-signed candidate 也没有经过受保护的 GitHub 发布工作流，`v1.0.5` 尚未创建或推送 tag，没有 Draft/正式 GitHub Release，公开 Latest 仍为 `v1.0.4`。

此前 `v1.0.4` 的本机/实号证据继续有效：火山方舟、百炼和第三方兼容服务分别完成了低输出上限的真实模型列表与文本调用；MiniMax M3 的原生 thinking object 已实号验证，Kimi 由账号返回“产品未激活”，没有伪报成功。正式 APK 已从 GitHub 下载到 `D:\EmbezzleStudio-Releases\v1.0.4`，其 aapt、权限、单签名证书、apksigner v2/v3、zipalign、SHA-256、GitHub asset digest 与 checksum 均已独立复核。

2026-07-10 远端验证：PR #7 把 Draft 读取权限隔离到最小预检 Job，并合并为 `b70eea32440300eddd0000a9b8a5f3fa28679280`；生产工作流 `29074959109` 从受保护的 `v1.0.4` 应用源码提交 `0062d16329989cdcbba1edad4ff8945176126feb` 完成构建、正式签名和 immutable 发布。Latest 已是 `v1.0.4`，APK 为 93,087,208 字节，SHA-256 `187f4a90daed7c7d05d423890419d1c4fe1d705674bf1d4955075c8d725b63f0`，证书 SHA-256 为 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`。`gh release verify` 与三个 `verify-asset` 均通过；Pages run `29076831325` 成功，公开 manifest、`release.html` 和匿名 APK 下载均为 1.0.4 且字节摘要一致。真机矩阵和 Kimi 产品开通仍未完成。
