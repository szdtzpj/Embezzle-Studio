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

历史状态：以上本地与协议实现已在 `1.1.0` / code 7 开发阶段完成；Embezzle Studio 不提供付费 API、生产代理、汇率服务、同步服务器或任务 worker。真实账号产品开通、计费证据、Android 麦克风/播放和并发压力仍是外部验收边界；截至该历史阶段，公开 Latest 仍为 `v1.0.6`。

2026-07-11 `1.1.0` 历史本机验证：`npm.cmd run check` 通过 21 个测试文件/423 个测试，TypeScript 与 ESLint 零错误/警告；最终 Web export 通过（3249 modules、主 bundle 7.2 MB），Expo Doctor 20/20，`expo install --check` 通过。390×844 导出 Web 覆盖新增设置中心、模板保存/插入，并实际证明生产式 Web 请求在接触本机代理前 fail-closed，console 为 0 error / 0 warning。3 个 workflow YAML、35 个 Bash block 和 `git diff --check` 通过。

历史 `1.1.0` 干净 Android prebuild 与 `NODE_ENV=production` 未签名 Release 构建通过。本地正式证书候选位于 `D:\EmbezzleStudio-Releases\v1.1.0-candidate\Embezzle-Studio-v1.1.0-candidate-release.apk`，大小 97,198,551 字节，SHA-256 `f4a0062fc03d320bb5e3915b6b9a0cdb3a80ee16b4ad18cce78edfd79f92cd80`；包名 `com.szdtzpj.embezzlestudio`、版本 `1.1.0`/code 7、minSdk 24/targetSdk 36。`RECORD_AUDIO` 为请求式语音的有意权限，overlay/camera 缺席；单一正式签名者、v2/v3 与 zipalign 通过。该候选未 tag、未上传、未发布，只能作为上一阶段证据，不能证明 `1.2.0`。

已发布的 `1.0.6` 包含并取代此前 `1.0.5` 的真机反馈修复：待发送图片使用 1:1 方形真实预览；对话视频改为 `expo-video` 原生内嵌播放器和全屏控件；视频文件名与“保存/分享”位于不会被卡片裁切的独立操作区；Android 保存使用系统 Storage Access Framework，不申请宽泛媒体库权限。原生图片选择不再额外请求整张 Base64，以降低高分辨率图片进入 JS 堆时的峰值。

该版本还把 Android 键盘模式设为 `resize`，让聊天和改名对话框参与键盘避让；模型选择 `Modal` 使用真实 bottom inset 并让列表可收缩滚动；聊天页在设置页打开时保持挂载，设置页首次打开后复用，Android 使用较轻的按压/页面/消息呈现，并把候选模型按每批 60 条加载。Expo 模板图标/施工网格已被双带 S 品牌套件和显式原生启动页取代，三个思考圆点则被一个带清理逻辑的折叠变形标志取代。用户已在其真机确认此前四项主路径解决，并随后授权当前版本发布；发布授权不等同于最终 Actions APK 的连接设备测试，新安全区/品牌/动画、更多设备、异常路径和压力矩阵仍待独立覆盖。

## M2.6 - Local Workspace and Cost Safety

- 本地 projects：项目指令、默认模型和会话归属保存在本机，删除项目时明确迁移会话。
- conversation branches：从消息克隆分支时重建消息/对比组 ID，并用 canonical `originMessageId` 在用量分析与任务中心去重。
- bounded local global search：只对项目、模板、会话和消息做有查询长度、扫描文档数和结果数上限的本地字面量搜索，不索引服务商、Key、插件或费用账本。
- provider setup wizard：服务商类型、规范化 Endpoint 与 Key 作为一个绑定；绑定改变先清除旧 Key/模型/候选，百炼 Coding Plan/Token Plan 端点及 `sk-sp-` 套餐凭据对自定义应用 fail-closed。
- evidence-backed capability matrix：服务商/模型声明与客户端真正实现并测试的协议能力分栏，不因目录标签自动启用网络路由。
- local cost guard：发送前执行 output token cap、未知费用策略、多模型目标数和潜在多次收费确认；本地 attempt ledger 记录状态及已知/未知费用。每日 CNY/USD 阈值只在当天“已完成请求的已知累计”达到阈值后提醒/阻断下一次请求，不预测当前请求是否跨线，也不是服务商真实账单。

M2.6 对应的历史开发目标为 `1.2.0` / code 8；其本机候选未公开。Embezzle Studio 不购买、补贴或转售任何 API/搜索/语音/媒体额度，不运行生产 API、代理、汇率、同步、遥测或任务 worker；所有服务商调用与费用由用户账号承担。CNY/USD 不做汇率换算，未知费用不按 0 处理，`providerUsageEvents` 不进入外部导出备份。

2026-07-11/12 历史证据：`npm.cmd run check` 通过 27 个测试文件 / 528 个测试，TypeScript 与 ESLint 零错误/警告；项目/分支/搜索、Endpoint/Key 重绑与百炼套餐阻断、声明能力和客户端能力分离、费用护栏/未知费用、端点绑定密钥的原子持久化、备份导入临界区及精确 output token 字段均有定向覆盖。Web export 通过（3,254 modules / 7.3 MB），390×844 浏览器覆盖项目创建/搜索/导航、Endpoint 改动清 Key、费用草稿与 v1.2.0，console 0 error / 0 warning；`expo install --check`、Expo Doctor 20/20、3 份 workflow YAML、35 个 Bash 块、16 个 Action 完整 SHA 与 `git diff --check` 均通过。干净 prebuild/`clean assembleRelease` 和正式证书本机签名通过；候选 `D:\EmbezzleStudio-Releases\v1.2.0-candidate\Embezzle-Studio-v1.2.0-candidate-release.apk` 为 97,313,239 字节，SHA-256 `872f32a48320f2a20dadee6fc0f699668666d067a60e546a19467ed922082da0`，版本 1.2.0/code 8、min/target 24/36、`allowBackup=false`、有意 `RECORD_AUDIO`、无 CAMERA/overlay，单一正式签名者、v2/v3 与 zipalign 通过。它未 push、tag、上传或发布。

## M2.7 - Local Knowledge and Artifact Workbench

- 项目成果：从消息捕获或创建 Markdown/纯文本/代码/JSON/HTML 成果，使用有上限的追加式版本、非破坏恢复、行级差异和当前版本导出。
- 项目资料：手写文本、消息/成果快照及受支持的纯文本/代码文件导入；不解析 PDF、Office、OpenDocument、媒体、压缩包或可执行文件。
- 本地检索：在本机对项目资料做有文档/分块/查询/结果上限的文字检索，不使用 embedding、远端索引或 Embezzle Studio 服务器，也不声称是向量 RAG。
- 显式上下文：仅当前会话明确选择的资料可以进入请求；消息可按完整因果轮次排除/置顶，上下文检查器展示实际纳入/裁剪、保守 Token 估计及附件未知量。
- 安全边界：不执行 HTML/代码，HTML 以 `.html.txt`/`text/plain` 惰性导出；资料标记为不可信引用但不承诺模型绝对抵抗提示注入，不做自动记忆、静默摘要或自动资料选择。压缩入口只生成可编辑提示草稿；用户之后用聊天模型手动发送时才使用其服务商账号、额度和费用护栏。
- 性能/容量：资料搜索延迟构建有界本机索引，工作台/检查器/主聊天初始分页渲染；成果全部版本与资料正文分别有 2,000,000 UTF-8 字节累计上限。比较目标统一使用最小上下文窗口的一份请求内容，图片/视频生成只发送最新提示词。
- 本地优先：成果、资料、检索、版本、差异、导出和预览无需 app-owned API、服务器、云同步或遥测；真正发送给模型时才消耗用户自己的 API。

`1.3.0` / code 9 的最终本机质量门已完成：`npm.cmd run check` 通过 38 个测试文件 / 634 个测试，TypeScript/ESLint 干净；Web export 为 3,259 modules / 7.4 MB。全新 390×844 导出 Web 会话验证 HTML `.html.txt` 惰性导出与内容、成果版本历史、成果转资料、有界本地搜索、显式资料选择实际从 0 变为 1，以及上下文压缩只生成草稿而不发送；console 0 error / 0 warning，且没有非静态请求。`expo install --check`、Expo Doctor 20/20、3 份 YAML、35 个 Bash `bash -n`、16 个官方 Action 完整 SHA、diff/密钥边界检查均通过。最终审计还覆盖保守 Unicode/emoji Token 门槛、ID/Unicode 往返、聚合预算 fail-closed、备份大小/Endpoint 密钥拒绝和原子导入。

干净 prebuild、`clean assembleRelease` 与正式证书本机签名通过。本机候选 `D:\EmbezzleStudio-Releases\v1.3.0-candidate\Embezzle-Studio-v1.3.0-candidate-release.apk` 为 97,448,407 字节，SHA-256 `c95dafe6e6eb77f3a1a4c7504c6ad05c27218b45972de2e247db264ec4c777d4`；它只属于本机候选证据。PR #13 合并为 `ea9409f1ea3540520eaf469a0c777fe1bc87e7f8`，PR/main Quality `29176034579` / `29176125303`、初始 Pages `29176125307`、production Android `29176245049` 与发布后 Pages `29176763721` 均成功，tag `v1.3.0` 精确指向该提交。

正式 [`v1.3.0` Release](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.3.0) 已成为 Latest，immutable、非 prerelease 且有 3 个资产。正式 `Embezzle-Studio-v1.3.0-release.apk` 同为 97,448,407 字节，但 SHA-256 为 `b5e48387e62d99512ae18a2c4f4a80ddf482c3c1b489768e924845e0adceb7fe`，与本机候选不同；包名/版本/code 为 `com.szdtzpj.embezzlestudio` / 1.3.0 / 9，min/target 24/36，`allowBackup=false`，有意 `RECORD_AUDIO`，无 CAMERA/`SYSTEM_ALERT_WINDOW`，单一预期正式 signer、证书 SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`，v2/v3、zipalign、Release attestation 和 3 个 asset attestation 均通过。正式资产另存于 `D:\EmbezzleStudio-Releases\v1.3.0`；公开 manifest/`release.html` 匿名 200 且精确匹配，完整公网 APK 下载保存到 `D:\EmbezzleStudio-Releases\v1.3.0-pages-public-verify-20260712-103132` 后大小/摘要一致。`adb devices -l` 仍为空，未做最终 Actions APK 连接真机、额外机型或真实服务商账号计费验收。详细契约见 [Local Knowledge and Artifact Workbench](./local-knowledge-workbench.md)。

## M3 - Plugins and MCP

- Remote MCP server manager with non-empty exact tool allowlists.
- Per-call full-argument approval prompts with approve, deny, and cancel actions.
- Official OpenAI Responses tool-call execution loop with `store: false` cumulative manual context, `parallel_tool_calls: false`, a four-approval cap, and conservative pre-send request-attempt counting.
- Plugin manifest installer from URL or local file.
- Plugin marketplace/import format for private use.

当前状态：精确官方 `api.openai.com` 的 provider-hosted Responses MCP 已实现。客户端只发送用户自有服务商 Key 与远程 MCP 授权，不建设 Embezzle Studio API、MCP 网关或审批服务器；配置只接受公网 HTTPS Endpoint，凭据不进入备份或日志。执行路径要求非空精确白名单，每个调用展示完整参数并单独批准、拒绝或取消，最多 4 次审批；每次初始或续接 Response 都在发送前保守登记为可能计费的请求尝试，最终仍以服务商账单为准。续接始终保持 `store: false`，累计原始输入、全部前序 output 和审批响应，并关闭并行工具调用。`store: false` 不覆盖服务商安全日志、组织数据控制或远程 MCP 自身的保留政策。安全 MCP 首版与联网搜索、多模型 comparison 互斥。

Ark 官方已有审批协议，但运行时继续关闭，直到真实账号证明 `store: false` 可以用完整本地上下文无存储续接；百炼 Responses 没有等价的执行前审批暂停点，也继续关闭。OpenAI 真实账号与可信测试 MCP Server 的 Android 只读、拒绝及可逆写入验收仍是外部边界，不得从本地自动化推断为已经完成。详细设计和发布门槛见 [v1.4 安全 MCP 工具](./safe-mcp-tools.md)。

`1.4.0` / code 10 的本机候选质量门已完成：41 个测试文件 / 749 个测试、TypeScript/ESLint、3,264-module Web export（7.4 MB）、Expo 依赖检查/Doctor 20/20、390×844 本地拦截浏览器批准/拒绝/取消路径、YAML/Bash/Action-SHA/diff/敏感边界检查均通过。干净 Android prebuild/未签名 Release、正式证书本机签名、aapt/apksigner/zipalign 复核通过；候选 `D:\EmbezzleStudio-Releases\v1.4.0-candidate\Embezzle-Studio-v1.4.0-candidate-release.apk` 为 97,518,039 字节，SHA-256 `683eb6e98efec3e301594e59c627b3698b410c2a58f841b3c3c3642b1a2a20ed`。它未 push、tag、上传或发布；无连接真机或真实 OpenAI/MCP 账号验收。完整证据见 [v1.4 continuation checkpoint](./CONTINUATION_CHECKPOINT_2026-07-12_V1.4.md)。

## M4 - Collaboration Handoff

- Android APK build pipeline.
- EAS or local Gradle build documentation.
- Test matrix for representative providers.
- Release checklist and signing notes.

当前状态：仓库已经定义 PR/Push 质量工作流，以及“精确 main tag -> owner draft -> main-only 隔离预检 -> 未签名构建 -> 正式 keystore 单签名 -> GitHub asset digest/uploader 校验 -> immutable Release -> Pages 公共更新清单与可信 `release.html` 下载页”的 CI 流程。Pages 只接受 owner 发布且由 Actions 上传资产的 Immutable Release，并在 APK 字节、GitHub digest 与对应校验文件全部匹配后公开下载页。当前 stable Latest `v1.3.0` 已完成 Release/3 个资产 attestation、证书指纹、Pages manifest/下载页与匿名完整 APK 字节验证；M4 的发布工程部分已闭环，剩余门槛是最终 Actions APK 的连接真机、代表性设备矩阵和更广的真实服务商账号/媒体任务矩阵。

当前个人私有仓库在 GitHub Free、Pro 或 Team 方案下不能为 Environment 启用 required reviewers；私有仓库的 Environment secrets 与 deployment branch/tag 限制又至少需要 Pro/Team。个人私有仓库的直接 collaborator 没有 read 档；按维护者决定，`BlueOcean223` 保留为明确受信任的 write collaborator。owner-only main/tag Ruleset、main-only Environment 与 workflow actor gate 能把篡改降为 fail-closed，但不等价于双人审批，也不能消除 write collaborator 对 draft/Release 的拒绝服务风险。

2026-07-10 `1.0.6` 发布前本机验证：`npm.cmd run check` 通过 15 个测试文件/252 个测试，TypeScript 与 ESLint 为零错误/警告；Web export 通过（3137 modules、主 bundle 6.9 MB）；Expo Doctor 20/20，`expo install --check` 通过。390×844 导出 Web 干净会话覆盖聊天、模型弹层、设置和返回导航，console 为 0 error / 0 warning；另一次 loopback 延迟响应真实触发了新的折叠标志并正常完成回答。3 个 workflow YAML、35 个 Bash block 和 `git diff --check` 均通过。

干净 Expo prebuild 与未签名 `assembleRelease` 已通过。发布前使用与正式 `v1.0.4` 相同证书签出的本地验收候选位于 `D:\EmbezzleStudio-Releases\v1.0.6-candidate\Embezzle-Studio-v1.0.6-candidate-release.apk`，大小 96,682,256 字节，SHA-256 `51186c1b746210ce60d0c79f84751785f2927766831b4d84566e1b0191baeea0`。其包名为 `com.szdtzpj.embezzlestudio`，版本 `1.0.6`/code 6，minSdk 24/targetSdk 36；正式证书 SHA-256 为 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`，单一签名者、v2/v3 和 zipalign 通过，无 overlay/camera/microphone 权限。这个 candidate 只保留为预发布本机证据，不与 Actions 重建的正式 APK 字节混用；`ACCESS_NETWORK_STATE` 与 `WAKE_LOCK` 仍来自视频播放依赖。

用户已在其 Android 真机上确认此前四个问题的主路径——键盘避让、Seedance 预览/下载、图片预览尺寸和设置/聊天切换——均已解决，之后授权当前版本发布；这是用户验收与发布决定，不是本机自动化产生的最终 APK 真机证据。当前 `adb devices -l` 仍为空，因此新增安全区、桌面/圆形/主题图标、启动页、原生动画，以及额外机型、SAF 取消/失败/空间不足、远端媒体过期和长时间压力矩阵仍待独立验证。

此前 `v1.0.4` 的本机/实号证据继续有效：火山方舟、百炼和第三方兼容服务分别完成了低输出上限的真实模型列表与文本调用；MiniMax M3 的原生 thinking object 已实号验证，Kimi 由账号返回“产品未激活”，没有伪报成功。正式 APK 已从 GitHub 下载到 `D:\EmbezzleStudio-Releases\v1.0.4`，其 aapt、权限、单签名证书、apksigner v2/v3、zipalign、SHA-256、GitHub asset digest 与 checksum 均已独立复核。

2026-07-10 远端验证：PR #7 把 Draft 读取权限隔离到最小预检 Job，并合并为 `b70eea32440300eddd0000a9b8a5f3fa28679280`；生产工作流 `29074959109` 从受保护的 `v1.0.4` 应用源码提交 `0062d16329989cdcbba1edad4ff8945176126feb` 完成构建、正式签名和 immutable 发布。Latest 已是 `v1.0.4`，APK 为 93,087,208 字节，SHA-256 `187f4a90daed7c7d05d423890419d1c4fe1d705674bf1d4955075c8d725b63f0`，证书 SHA-256 为 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`。`gh release verify` 与三个 `verify-asset` 均通过；Pages run `29076831325` 成功，公开 manifest、`release.html` 和匿名 APK 下载均为 1.0.4 且字节摘要一致。真机矩阵和 Kimi 产品开通仍未完成。

2026-07-10 `v1.0.6` 远端验证：PR #10 合并为精确发布提交 `888db913c154fc60fdc7fa4b9de947be55ab10c0`，其 PR 与 merge-SHA Quality、tag 前 Pages 均成功。生产工作流 [`29092367202`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29092367202) 从同一 tag/main 提交干净重建、正式签名并发布 stable immutable Latest；正式 APK 下载到 `D:\EmbezzleStudio-Releases\v1.0.6`，大小 96,805,335 字节，SHA-256 `1a1fa2d5dc2bac2293994a92e0e65e7033bb4006082e503125d580c778d104f9`。Release attestation、三个 `verify-asset`、checksum、GitHub digest/uploader、`aapt`、单签名 v2/v3 与 zipalign 均通过。Pages run [`29094337390`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29094337390) 成功，公开 manifest、可信 `release.html`、HEAD 元数据与匿名完整 APK 下载均为 1.0.6 且字节摘要一致。
