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

当前状态：仓库已经定义 PR/Push 质量工作流，以及“未签名构建 -> 正式 keystore 签名 -> 证书指纹校验 -> SHA-256 -> Release -> Pages 公共更新清单与可信 `release.html` 下载页”的 CI 流程。Pages 只在 APK 字节与对应校验文件匹配后公开下载页，客户端只接受本仓库精确 GitHub/Pages 路径。`v1.0.3` 及更早 APK 仍是 debug-signed 测试包；只有在 `android-release` 环境配置并离线备份稳定正式密钥、发布首个通过指纹校验的 APK，并完成代表性 Android 版本/设备与真实服务商账号测试矩阵后，M4 才能视为完成。

2026-07-10 本机验证：12 个测试文件/183 个测试、Web export、Expo Doctor 20/20、workflow YAML/8 段 Bash/15 个 Action SHA、桌面与 390×844 导出 Web 冒烟均通过；clean Android 1.0.4/code 4 APK 的 aapt、权限、apksigner v2、zipalign 和 SHA-256 也已复核。该 APK 仍为本机 Android Debug 证书，且没有连接 Android 设备或真实服务商账号，因此这些证据不会把 M4 提前标记为完成。
