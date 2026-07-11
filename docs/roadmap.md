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

当前实现边界：图片、视频和文件选择 UI 已按模型能力启用；选择器已经实施数量、单项大小、总大小和图片像素上限。百炼兼容模式已支持有界的本地视频 `video_url`，OpenAI 官方 API 已支持显式 `file-input` 模型的文件附件，火山方舟已支持带参考素材的视频生成任务。`1.1.0` 开发分支新增 Android 请求式语音：OpenAI/百炼用户账号可以转写前台录音并生成回答朗读；火山语音因独立凭证协议、Realtime 因需要 token broker 而保持关闭。其他服务商的视频上传/转码、自动压缩及更广语音协议仍未完成，因此 M2 尚未整体完成。

## M2.5 - BYOK Productivity

- 2–4 模型同问对比、整组停止与单候选上下文选择。
- OpenAI/火山方舟/阿里百炼官方 Responses 联网搜索与可点击引用证据。
- 本地提示词/角色模板、媒体任务中心和 Token/延迟/用户价格估算。
- 不含 API Key/MCP 授权/媒体的 XChaCha20-Poly1305 加密备份与严格导入。

当前状态：以上本地与协议实现已进入 `1.1.0` / code 7 开发分支；Embezzle Studio 不提供付费 API、生产代理、汇率服务、同步服务器或任务 worker。真实账号产品开通、计费证据、Android 麦克风/播放和并发压力仍是外部验收边界，当前公开 Latest 仍为 `v1.0.6`。

2026-07-11 `1.1.0` 本机验证：`npm.cmd run check` 通过 21 个测试文件/423 个测试，TypeScript 与 ESLint 零错误/警告；最终 Web export 通过（3249 modules、主 bundle 7.2 MB），Expo Doctor 20/20，`expo install --check` 通过。390×844 导出 Web 覆盖新增设置中心、模板保存/插入，并实际证明生产式 Web 请求在接触本机代理前 fail-closed，console 为 0 error / 0 warning。3 个 workflow YAML、35 个 Bash block 和 `git diff --check` 通过。

干净 Android prebuild 与 `NODE_ENV=production` 未签名 Release 构建通过。本地正式证书候选位于 `D:\EmbezzleStudio-Releases\v1.1.0-candidate\Embezzle-Studio-v1.1.0-candidate-release.apk`，大小 97,198,551 字节，SHA-256 `f4a0062fc03d320bb5e3915b6b9a0cdb3a80ee16b4ad18cce78edfd79f92cd80`；包名 `com.szdtzpj.embezzlestudio`、版本 `1.1.0`/code 7、minSdk 24/targetSdk 36。`RECORD_AUDIO` 为请求式语音的有意权限，overlay/camera 缺席；单一正式签名者、v2/v3 与 zipalign 通过。该候选未 tag、未上传、未发布，公开 Latest 仍为 `v1.0.6`。

已发布的 `1.0.6` 包含并取代此前 `1.0.5` 的真机反馈修复：待发送图片使用 1:1 方形真实预览；对话视频改为 `expo-video` 原生内嵌播放器和全屏控件；视频文件名与“保存/分享”位于不会被卡片裁切的独立操作区；Android 保存使用系统 Storage Access Framework，不申请宽泛媒体库权限。原生图片选择不再额外请求整张 Base64，以降低高分辨率图片进入 JS 堆时的峰值。

该版本还把 Android 键盘模式设为 `resize`，让聊天和改名对话框参与键盘避让；模型选择 `Modal` 使用真实 bottom inset 并让列表可收缩滚动；聊天页在设置页打开时保持挂载，设置页首次打开后复用，Android 使用较轻的按压/页面/消息呈现，并把候选模型按每批 60 条加载。Expo 模板图标/施工网格已被双带 S 品牌套件和显式原生启动页取代，三个思考圆点则被一个带清理逻辑的折叠变形标志取代。用户已在其真机确认此前四项主路径解决，并随后授权当前版本发布；发布授权不等同于最终 Actions APK 的连接设备测试，新安全区/品牌/动画、更多设备、异常路径和压力矩阵仍待独立覆盖。

## M3 - Plugins and MCP

- Remote MCP server manager.
- Tool permission prompts.
- Tool-call execution loop in chat.
- Plugin manifest installer from URL or local file.
- Plugin marketplace/import format for private use.

当前状态：远程 HTTPS MCP 配置、独立安全存储、私网/内嵌凭据拒绝、默认关闭和权限确认已经实现；真实工具执行仍保持 fail-closed。OpenAI/Ark 的 `mcp_approval_request -> mcp_approval_response` 循环、参数/拟发送数据预览、工具白名单和真实服务器测试完成前不得把配置状态描述为可执行 MCP。百炼缺少同等逐次审批契约时不开放写工具。

## M4 - Collaboration Handoff

- Android APK build pipeline.
- EAS or local Gradle build documentation.
- Test matrix for representative providers.
- Release checklist and signing notes.

当前状态：仓库已经定义 PR/Push 质量工作流，以及“精确 main tag -> owner draft -> main-only 隔离预检 -> 未签名构建 -> 正式 keystore 单签名 -> GitHub asset digest/uploader 校验 -> immutable Release -> Pages 公共更新清单与可信 `release.html` 下载页”的 CI 流程。Pages 只接受 owner 发布且由 Actions 上传资产的 Immutable Release，并在 APK 字节、GitHub digest 与对应校验文件全部匹配后公开下载页。当前 stable Latest `v1.0.6` 已完成 Release attestation、三个正式资产、证书指纹、Pages manifest/下载页与匿名完整 APK 字节验证；M4 的发布工程部分已闭环，剩余门槛是代表性设备矩阵和更广的真实服务商账号/媒体任务矩阵。

当前个人私有仓库在 GitHub Free、Pro 或 Team 方案下不能为 Environment 启用 required reviewers；私有仓库的 Environment secrets 与 deployment branch/tag 限制又至少需要 Pro/Team。个人私有仓库的直接 collaborator 没有 read 档；按维护者决定，`BlueOcean223` 保留为明确受信任的 write collaborator。owner-only main/tag Ruleset、main-only Environment 与 workflow actor gate 能把篡改降为 fail-closed，但不等价于双人审批，也不能消除 write collaborator 对 draft/Release 的拒绝服务风险。

2026-07-10 `1.0.6` 发布前本机验证：`npm.cmd run check` 通过 15 个测试文件/252 个测试，TypeScript 与 ESLint 为零错误/警告；Web export 通过（3137 modules、主 bundle 6.9 MB）；Expo Doctor 20/20，`expo install --check` 通过。390×844 导出 Web 干净会话覆盖聊天、模型弹层、设置和返回导航，console 为 0 error / 0 warning；另一次 loopback 延迟响应真实触发了新的折叠标志并正常完成回答。3 个 workflow YAML、35 个 Bash block 和 `git diff --check` 均通过。

干净 Expo prebuild 与未签名 `assembleRelease` 已通过。发布前使用与正式 `v1.0.4` 相同证书签出的本地验收候选位于 `D:\EmbezzleStudio-Releases\v1.0.6-candidate\Embezzle-Studio-v1.0.6-candidate-release.apk`，大小 96,682,256 字节，SHA-256 `51186c1b746210ce60d0c79f84751785f2927766831b4d84566e1b0191baeea0`。其包名为 `com.szdtzpj.embezzlestudio`，版本 `1.0.6`/code 6，minSdk 24/targetSdk 36；正式证书 SHA-256 为 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`，单一签名者、v2/v3 和 zipalign 通过，无 overlay/camera/microphone 权限。这个 candidate 只保留为预发布本机证据，不与 Actions 重建的正式 APK 字节混用；`ACCESS_NETWORK_STATE` 与 `WAKE_LOCK` 仍来自视频播放依赖。

用户已在其 Android 真机上确认此前四个问题的主路径——键盘避让、Seedance 预览/下载、图片预览尺寸和设置/聊天切换——均已解决，之后授权当前版本发布；这是用户验收与发布决定，不是本机自动化产生的最终 APK 真机证据。当前 `adb devices -l` 仍为空，因此新增安全区、桌面/圆形/主题图标、启动页、原生动画，以及额外机型、SAF 取消/失败/空间不足、远端媒体过期和长时间压力矩阵仍待独立验证。

此前 `v1.0.4` 的本机/实号证据继续有效：火山方舟、百炼和第三方兼容服务分别完成了低输出上限的真实模型列表与文本调用；MiniMax M3 的原生 thinking object 已实号验证，Kimi 由账号返回“产品未激活”，没有伪报成功。正式 APK 已从 GitHub 下载到 `D:\EmbezzleStudio-Releases\v1.0.4`，其 aapt、权限、单签名证书、apksigner v2/v3、zipalign、SHA-256、GitHub asset digest 与 checksum 均已独立复核。

2026-07-10 远端验证：PR #7 把 Draft 读取权限隔离到最小预检 Job，并合并为 `b70eea32440300eddd0000a9b8a5f3fa28679280`；生产工作流 `29074959109` 从受保护的 `v1.0.4` 应用源码提交 `0062d16329989cdcbba1edad4ff8945176126feb` 完成构建、正式签名和 immutable 发布。Latest 已是 `v1.0.4`，APK 为 93,087,208 字节，SHA-256 `187f4a90daed7c7d05d423890419d1c4fe1d705674bf1d4955075c8d725b63f0`，证书 SHA-256 为 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`。`gh release verify` 与三个 `verify-asset` 均通过；Pages run `29076831325` 成功，公开 manifest、`release.html` 和匿名 APK 下载均为 1.0.4 且字节摘要一致。真机矩阵和 Kimi 产品开通仍未完成。

2026-07-10 `v1.0.6` 远端验证：PR #10 合并为精确发布提交 `888db913c154fc60fdc7fa4b9de947be55ab10c0`，其 PR 与 merge-SHA Quality、tag 前 Pages 均成功。生产工作流 [`29092367202`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29092367202) 从同一 tag/main 提交干净重建、正式签名并发布 stable immutable Latest；正式 APK 下载到 `D:\EmbezzleStudio-Releases\v1.0.6`，大小 96,805,335 字节，SHA-256 `1a1fa2d5dc2bac2293994a92e0e65e7033bb4006082e503125d580c778d104f9`。Release attestation、三个 `verify-asset`、checksum、GitHub digest/uploader、`aapt`、单签名 v2/v3 与 zipalign 均通过。Pages run [`29094337390`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29094337390) 成功，公开 manifest、可信 `release.html`、HEAD 元数据与匿名完整 APK 下载均为 1.0.6 且字节摘要一致。
