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

当前状态：仓库已经定义 PR/Push 质量工作流，以及“精确 main tag -> owner draft -> 未签名构建 -> 正式 keystore 单签名 -> GitHub asset digest/uploader 校验 -> immutable Release -> Pages 公共更新清单与可信 `release.html` 下载页”的 CI 流程。Pages 只接受 owner 发布且由 Actions 上传资产的 Immutable Release，并在 APK 字节、GitHub digest 与对应校验文件全部匹配后公开下载页。`v1.0.3` 及更早 APK 仍是 debug-signed 测试包；只有在 `android-release` 配置并离线备份正式密钥、发布首个通过指纹和 attestation 校验的 APK，并完成真机与真实服务商账号矩阵后，M4 才能视为完成。

当前个人私有仓库在 GitHub Free、Pro 或 Team 方案下不能为 Environment 启用 required reviewers；私有仓库的 Environment secrets 与 deployment branch/tag 限制又至少需要 Pro/Team。个人私有仓库的直接 collaborator 没有 read 档，因此 `BlueOcean223` 只能保留为明确受信任的 write collaborator、被移除，或在迁移组织后重新分配角色。owner-only main/tag Ruleset 与 workflow actor gate 能把篡改降为 fail-closed，但不等价于双人审批，也不能消除 write collaborator 对 draft/Release 的拒绝服务风险。

2026-07-10 本机验证：当前源代码通过 12 个测试文件/231 个测试、Web export、Expo Doctor 20/20、workflow YAML/34 段 Bash/15 个 Action SHA 与 `git diff --check`。火山方舟、百炼和第三方兼容服务分别完成了低输出上限的真实模型列表与文本调用；MiniMax M3 的原生 thinking object 也已实号验证，Kimi 则由账号返回“产品未激活”，没有伪报成功。此前 clean Android 1.0.4/code 4 APK 的 aapt、权限、apksigner v2、zipalign 和 SHA-256 已复核，但它早于本轮 provider 修复，必须在合并后重新构建。最终本机 APK 仍只能使用 Android Debug 证书，且没有连接 Android 设备，因此这些证据不会把 M4 提前标记为完成。

2026-07-10 远端验证：PR #1–#5 已合并，main 为 `54f7ef75b924aeec072befe761734a37bc9be5b5`。GitHub 已有不可变预发布 `v1.0.4-debug.1`，其 92,979,061 字节调试签名 APK、SHA 文件和 apksigner 报告均可下载，APK digest 为 `945031c481475da160267e2c56a7738dc609d2930ef69136e198392efda1e211`；它只用于测试且必须由本轮 provider 修复后的新构建取代。稳定 Latest 仍是 v1.0.3，因此 Pages/应用更新链不会把调试包当生产更新。main 已强制 PR、严格 Quality 与讨论解决，并叠加 owner-through-PR 更新规则；`v*` 只允许 owner创建/更新且另有无 bypass 的禁止移动/删除规则。Actions 只允许 GitHub-owned、拒绝 verified third-party 并强制完整 SHA，Immutable Releases 已启用，`android-release` 仍只允许 `main` 且 secrets 为 0。正式签名备份、稳定 v1.0.4 Release、Pages 生产 APK、真机矩阵和 Kimi 产品开通仍未完成。
