<p align="center">
  <img src="./assets/brand-mark.png" width="280" alt="Embezzle Studio Logo" />
</p>

<h1 align="center">Embezzle Studio</h1>

<p align="center">
  <strong>把你的模型、资料与创作成果，装进一个由你掌控的移动工作台。</strong>
</p>

<p align="center">
  面向 Android 的 BYOK 多模型对话、创作与本地知识工作台
</p>

<p align="center">
  <a href="https://szdtzpj.github.io/Embezzle-Studio/release.html"><img alt="Latest Release" src="https://img.shields.io/github/v/release/szdtzpj/Embezzle-Studio?display_name=tag&amp;sort=semver&amp;style=for-the-badge&amp;color=7C3AED" /></a>
  <a href="https://github.com/szdtzpj/Embezzle-Studio/actions/workflows/quality.yml"><img alt="Quality" src="https://img.shields.io/github/actions/workflow/status/szdtzpj/Embezzle-Studio/quality.yml?branch=main&amp;style=for-the-badge&amp;label=quality" /></a>
  <img alt="Android 24+" src="https://img.shields.io/badge/Android-24%2B-3DDC84?style=for-the-badge&amp;logo=android&amp;logoColor=white" />
  <img alt="BYOK" src="https://img.shields.io/badge/BYOK-user--funded-0EA5E9?style=for-the-badge" />
</p>

<p align="center">
  <a href="https://szdtzpj.github.io/Embezzle-Studio/release.html"><strong>下载 Android 正式版</strong></a>
  · <a href="./docs/local-knowledge-workbench.md">本地知识工作台</a>
  · <a href="./docs/product-architecture.md">架构与安全边界</a>
  · <a href="./README.en.md">English</a>
</p>

<table>
  <tr>
    <td width="50%" valign="top"><strong>🔑 用户自有服务商</strong><br /><sub>模型、搜索、语音与媒体调用全部使用用户自己的 Endpoint、API Key、额度与账单。</sub></td>
    <td width="50%" valign="top"><strong>🛡️ Local-first</strong><br /><sub>项目、对话、成果、资料、检索与费用估算保存在本机，不依赖 Embezzle Studio 服务器。</sub></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><strong>⚡ 多模型统一工作台</strong><br /><sub>集中管理 OpenAI 兼容接口、火山方舟、阿里百炼和个人中转，并支持显式多模型对比。</sub></td>
    <td width="50%" valign="top"><strong>📚 从对话到成果</strong><br /><sub>把回答沉淀为可版本化成果与项目资料，在发送前检查实际上下文和 Token 风险。</sub></td>
  </tr>
</table>

## 当前功能

- 服务商配置：支持 OpenAI 兼容接口、火山方舟、百炼兼容模式、New API 中转站和自定义中转地址。`1.2.0` 的本地配置向导使用独立草稿检查服务商类型、Endpoint 与 Key 绑定；类型或规范化 Endpoint 改变时会先清除旧 Key、模型与候选，避免把凭据发送到新地址。百炼 Coding Plan/Token Plan 等不允许接入自定义应用的套餐端点会被阻断。
- 模型获取：OpenAI/兼容服务商尝试模型列表接口；火山方舟只在精确官方数据面主机上尝试未列入官方 API 参考的兼容 `/models` 探测，失败或响应不兼容时回退到根据官方目录维护的本地精选候选，并始终支持手动添加 Model ID 或 Endpoint ID。
- 模型选择：聊天页可按服务商查看已添加模型，并切换当前激活模型。能力矩阵把服务商/模型声明与客户端已经实现、测试过的协议能力分开显示，不会把目录标签当成可用适配器的证据。
- 对话协议：Chat Completions 默认流式输出；OpenAI Responses-only Pro 模型自动切换 `/responses` 非流式协议，并记录 Token 用量。
- 多模型同问：可选择 2–4 个用户服务商模型并行回答；整组共用停止控制，单个失败不丢弃其它结果，后续对话只携带用户选中的一个候选。界面会在发送前明确本次将产生多少次独立服务商调用。
- 可信联网搜索：使用用户自己的 Key 调用 OpenAI、火山方舟或阿里百炼官方 Responses 搜索协议；只有响应包含搜索调用、有效引用或百炼搜索计数证据时才标记为已联网，并把 HTTPS 来源展示为可点击链接。
- 思考设置：按精确模型系列保存思考强度，区分 `off`、`none`、`minimal`、`xhigh`、`max`，并分别映射 OpenAI、火山方舟和百炼协议。
- 参数调整：按服务商和模型只显示已适配的温度、top_p、惩罚参数及其真实范围；思考模式或固定参数模型会明确提示或隐藏无效控件，关闭后交给服务商默认值处理。
- 多模态入口：按模型能力显示图片、视频和文件选择入口；图片可发送给视觉模型，百炼兼容模式支持有界的本地视频 `video_url` 输入，文件输入仅对显式具备 `file-input` 能力的 OpenAI 官方模型开放。另支持文本生图，以及带参考图片/视频的火山方舟视频任务提交和后续查询。
- 媒体预览与导出：待发送图片显示为方形缩略图；对话中的视频使用 `expo-video` 原生控件在当前页播放并支持全屏。视频卡片把文件名与“保存/分享”操作放在独立操作区；Android 保存通过系统 Storage Access Framework 让用户选择目录，Web 使用浏览器下载，其它原生平台回退到系统分享。
- Android 布局与切页：主聊天区和改名对话框使用键盘避让，Android 配置为 `resize`；聊天页在打开设置后保持挂载，设置页首次打开后复用，并限制远端候选模型的单批渲染量以降低切页和大列表压力。
- 本地项目工作区：项目、项目指令、默认模型和会话归属都保存在本机；删除项目时会明确迁移其中会话，不依赖 Embezzle Studio 的同步服务。
- 本地成果工作台：`1.3.0` 可把消息保存为项目成果，或新建 Markdown/纯文本/代码/JSON/HTML 成果；编辑会追加有界版本，旧版本恢复会生成新版本而不破坏后续历史，并支持有界行级差异和当前版本导出。HTML 以 `.html.txt`/`text/plain` 惰性导出，不执行脚本、代码或网络预览。
- 项目资料与本地检索：可手写资料、从消息/成果保存快照，或导入受支持的纯文本/代码文件；项目内检索和分块均在本机有界完成。当前不解析 PDF/Word/Excel/PowerPoint/OpenDocument，也不声称这是向量 RAG、自动记忆或云端知识库。
- 显式上下文控制：资料只在当前会话明确勾选后才可注入聊天请求；检查器展示保守文本 Token 估计、实际纳入/裁剪/排除/置顶消息、附件不确定性与资料纳入/省略状态。比较模型共享最小窗口的一份上下文；图片/视频生成只发送最新提示词。压缩按钮只生成待审阅草稿，不自动扣费。
- 对话记录与全局搜索：本地保存历史会话，支持置顶、改名、分享、删除，以及对项目、模板、会话和消息做有长度/文档数/结果数上限的字面量全局搜索；搜索内容不会发送给服务商。
- 消息操作与对话分支：支持原生/网页复制、分享、停止生成、保留流式部分内容、重新生成、编辑、按因果分支删除，以及从任意消息克隆本地对话分支。分支重新生成消息/对比组 ID，并用 canonical `originMessageId` 在用量分析和任务中心去重，避免把同一历史事件重复累计。
- 本地生产力与费用护栏：提示词/角色模板、跨对话媒体任务中心、Token/延迟聚合、用户自填价格估算和费用护栏均在本机完成。护栏可限制输出 Token、每日请求次数、对比目标数并确认潜在多次收费；CNY/USD 阈值只依据当天已完成请求的本地已知累计，在累计达到阈值后提醒/阻断下一次请求，不预测当前请求是否跨线。本地 attempt ledger 区分已知估算与未知费用，未知费用绝不按 0 处理，也不冒充服务商真实账单。
- 请求式语音：Android 可用用户自己的 OpenAI 或阿里百炼账号完成录音转写与回答朗读；转写只写入草稿、不自动发送，朗读音频先下载到本机缓存并明确标识为 AI 合成语音。火山语音因使用独立 AppID/Token 协议而不会错误复用 Ark Key。
- 加密备份与凭据边界：配置/文字对话/模板可做带密码的本地认证加密导出；专用配置字段中的 API Key/MCP 授权、媒体文件和本机费用尝试账本 `providerUsageEvents` 不进入外部导出备份，MCP 授权与完整工具参数也不进入诊断日志。普通对话、提示词、模板和错误文字会按原样备份，请勿把密钥粘贴到这些文本中。Android 关闭系统自动应用备份，跨设备迁移应使用显式认证加密导出；`1.2.0` 历史候选、`1.3.0` 本机候选和 Actions 正式 APK 均已独立复核 `android:allowBackup="false"`。
- 安全远程 MCP（v1.4）：仅精确官方 `api.openai.com` Responses 路径可执行用户自己配置的公网 HTTPS MCP。每轮都保持 `store: false`，手动累计原始输入、所有前序输出和审批响应，设置 `parallel_tool_calls: false`，只暴露非空精确工具白名单，并在每一次调用前展示完整参数供用户批准、拒绝或取消；单轮最多 4 次审批，每次初始或续接请求都在发送前保守登记为一次可能计费的请求尝试，最终以服务商账单为准。`store: false` 只控制 Responses 对象存储，不自动覆盖 OpenAI 组织数据控制、安全日志或远程 MCP 自身的日志与保留政策。对话只保存不含参数/输出/凭据/远端 ID 的有界活动摘要，批准后中断会明确标为“结果不确定”，且摘要不进入备份。MCP 与联网搜索、多模型 comparison 首版互斥。Ark 虽有官方审批协议，但在真实账号证明无服务商存储续接前保持关闭；百炼 Responses 缺少执行前审批契约，也保持关闭。完整边界见 [v1.4 安全 MCP 工具](./docs/safe-mcp-tools.md)。
- 更新检查：从固定的公共 Pages 更新清单检查版本和已校验 APK 元数据，并跳转到受信任的发布页面；应用本身不会伪装成 APK 校验器或安装器。
- 本地存储：Android API Key 使用 SecureStore；Web API Key 只保留在当前标签页的 `sessionStorage`/内存中，并会迁移清除旧版持久化值。工作区使用带版本和备份的 AsyncStorage；原生附件复制到应用文件目录，Web 附件以 Blob 存入 IndexedDB，避免把大型 Base64 写进工作区 JSON。

## 仍在完善

当前稳定 Latest 已是 [`v1.3.0`](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.3.0) / Android versionCode 9；它是 immutable、非 prerelease 且包含 3 个正式资产。现有 `1.2.0` 本机候选只属于上一开发阶段的历史证据，不能当作 `1.3.0` APK；`1.3.0` 本机候选也必须与 Actions 正式 APK 分开核对。

Embezzle Studio 不购买、转售、补贴或代理模型、搜索、语音、媒体或 MCP 能力，也不运行生产 API、MCP 网关、审批服务器、汇率服务、云同步、遥测后端或任务 worker。所有服务商与工具调用及费用都由用户配置的账号承担；本地费用护栏不做汇率换算，且其估算/尝试账本不能替代服务商账单。

- 对话视频附件目前只为百炼兼容模式实现 `video_url` 传输；其他服务商仍需各自的上传、转码或引用协议适配。
- 用户已在一台 Android 真机上确认键盘避让、Seedance 预览/下载、图片预览尺寸和设置/聊天切换的主路径解决；更多机型、系统目录取消/失败/空间不足、远程媒体过期和长时间压力矩阵仍需验收。Web 回归不能替代这些扩展原生验证。
- OpenAI 官方安全 MCP 的本地执行与逐次审批闭环已经实现，但尚未用真实 OpenAI 账号和可信测试 MCP Server 在 Android 真机完成只读、拒绝及可逆写操作验收。Ark 与百炼仍只保存安全配置、不执行工具：前者等待真实账号验证 `store: false` 无存储续接，后者等待 Responses 提供执行前审批契约。
- 联网搜索与语音的协议和解析已有自动化测试，但用户账号是否开通对应付费产品、真实搜索计费证据、麦克风/播放和长时间并发仍需代表性账号与 Android 真机验收。
- OpenAI 官方接口不会返回原始隐藏思考链；应用只能展示接口返回的思考摘要、reasoning_content 或 Token 用量。
- Android 安装包构建需要本机 Android 工具链，或通过 CI/EAS 等方式构建。

## 附件限制与存储边界

- 一条待发送消息最多选择 6 个附件；单张图片上限 10 MiB 且不超过 3200 万像素，单个视频上限 100 MiB，单个普通文件上限 20 MiB，附件总量上限 120 MiB。
- 百炼本地视频在发送前会转成 Base64 Data URL；编码后的完整 Data URL 还必须不超过 10 MiB，因此视频选择器的 100 MiB 通用上限并不代表百炼内联请求可以发送同等大小的视频。超限时应改用服务商支持的公网 HTTPS URL 或外部上传流程。
- Web 附件持久化为 IndexedDB Blob；界面只在预览时创建短期 `blob:` URL。原生附件持久化到应用拥有的文档目录。删除附件时，物理数据只会在新的工作区快照成功保存且已不再引用它之后清理。
- 文件附件只发送到 OpenAI 官方 API：Chat Completions 使用 `file` 内容，Responses 使用 `input_file`；兼容中转不会被假定支持同一文件协议。

## 技术栈

- Expo SDK 57
- React Native 0.86
- React 19.2
- TypeScript 6
- React Native Reanimated
- React Native Gesture Handler
- Expo Video
- Expo Audio
- Expo Crypto + Noble Ciphers/Hashes
- AsyncStorage
- SecureStore

## 本地开发

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd run test
npm.cmd run lint
npm.cmd run build:web
npm.cmd start
```

Web 调试可以使用：

```powershell
npm.cmd run web
```

该命令启动的转发器仅用于本机开发：它只监听 loopback，并只接受本次 Expo Web 的精确 origin。它仍可代表该页面访问任意用户配置的 HTTP(S) 上游，因此不得部署成生产代理，也不应在同一开发 origin 运行不受信任脚本。

Pull Request 和 `main` 分支推送会触发 `.github/workflows/quality.yml`。只有依赖安装、TypeScript 检查、测试、Lint 和 Web 构建全部通过，改动才应合并。建议把 `Quality / Typecheck, test, lint, and build web` 配置为 `main` 的必需检查。

## Android 正式签名与发布

`.github/workflows/android-apk.yml` 只允许仓库所有者从 `main` 使用稳定的正式密钥签名。读取 owner-authored Draft 的 `contents: write` 仅存在于短小的 `release_contract` 预检 Job；预检和发布都受仅允许 `main` 的 `android-release` Environment 约束，实际 npm/Expo/Gradle 构建继续使用仓库默认的 `contents: read`，且 checkout 不持久化凭据。签名前会用固定的 Android Build Tools 36.0.0 核对实际 APK 的包名、版本、min/target SDK 与禁用权限，证明待签 APK 尚无有效签名，并在签名后只接受一个与固定指纹一致、且不是 `Android Debug` 的签名者。缺少任一签名 Secret、产物契约不符或工具链/证书校验失败时，工作流会直接失败；所有官方 Actions 都使用 GitHub 验证的最新稳定完整 SHA，并运行在 Node 24 代际。

首个正式签名版本 [`v1.0.4`](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.0.4) 于 2026-07-10 首次跑通 production-signing、immutable Release 与可信 Pages 下载链。此前稳定版 [`v1.0.6`](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.0.6) 的受保护 [Android run `29092367202`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29092367202) 从精确提交 `888db913c154fc60fdc7fa4b9de947be55ab10c0` 干净重建并签出 96,805,335 字节 APK，SHA-256 `1a1fa2d5dc2bac2293994a92e0e65e7033bb4006082e503125d580c778d104f9`；Release attestation、三个下载资产与 [Pages run `29094337390`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29094337390) 的历史验证继续有效。

已发布的 `1.0.6` / Android versionCode 6 包含此前 `1.0.5` 的键盘、图片/视频预览、导出和切页稳定性修复。模型选择 `Modal` 现在使用真实 bottom safe-area inset 并允许滚动区收缩，避免三键导航栏遮住最后一行；原 Expo 模板图标/施工网格已替换为统一的双带 S 标志、Android adaptive/monochrome 图标、Web favicon 和显式 `expo-splash-screen` 启动画面；回答等待状态也从三个跳动圆点改为单一折叠变形标志。

`1.0.6` 发布源码已通过 `npm.cmd run check`（15 个测试文件、252 个测试，TypeScript/ESLint 零错误或警告）、Web export（3137 modules、主 bundle 6.9 MB）、Expo Doctor 20/20 与 `expo install --check`。导出产物的 390×844 干净浏览器会话覆盖聊天、模型弹层和设置往返，console 为 0 error / 0 warning；本地延迟响应还实际触发了新的单标志动画并正常收束为回答。3 个 workflow YAML 和其中 35 个 Bash block 也重新通过解析/`bash -n`。

发布前的本地 production-signed candidate 保留在 `D:\EmbezzleStudio-Releases\v1.0.6-candidate`，用于证明最终源码和正式证书在本机工具链下也可通过；它不是公开资产。GitHub 正式三项资产已下载到 `D:\EmbezzleStudio-Releases\v1.0.6`，其中 APK 的包名为 `com.szdtzpj.embezzlestudio`、版本 `1.0.6`/versionCode 6、minSdk 24/targetSdk 36；单一正式签名者、v2/v3 和 zipalign 通过，且没有 overlay、camera 或 microphone 权限。用户在 Android 真机上确认此前四个问题的主路径解决，并随后授权当前版本上线；前者属于用户验收，后者不等同于本次会话连接设备产生的最终 APK 测试日志。当前 `adb devices -l` 仍为空，因此新增安全区、桌面/主题图标、启动页、原生动画，以及额外机型、SAF 取消/失败/空间不足、远端媒体过期和长时间压力矩阵仍待独立验证。

历史开发版 `1.2.0` / versionCode 8 已完成本机质量门、Web 导出与 390×844 浏览器回归、Expo Doctor 20/20、3 份 workflow YAML、35 个 Bash 块、干净 Android prebuild/Release 构建和正式证书候选签名。候选 APK 位于 `D:\EmbezzleStudio-Releases\v1.2.0-candidate\Embezzle-Studio-v1.2.0-candidate-release.apk`，97,313,239 字节，SHA-256 `872f32a48320f2a20dadee6fc0f699668666d067a60e546a19467ed922082da0`；`aapt`/打包 Manifest 证明版本、SDK、`RECORD_AUDIO` 与 `allowBackup=false`，CAMERA/overlay 缺席，`apksigner` 证明单一预期正式证书、v2/v3 和 zipalign。它仍是上一源码阶段的本地候选，不是 `1.3.0` 证据、GitHub Release 或公开 APK。

`1.3.0` 最终本机质量门已通过：`npm.cmd run check` 为 38 个测试文件 / 634 个测试，TypeScript/ESLint 干净；Web export 为 3,259 modules / 7.4 MB。全新 390×844 导出 Web 会话验证 HTML `.html.txt` 惰性导出与内容、成果版本历史、成果转资料、有界本地搜索、显式资料选择实际从 0 变为 1，以及上下文压缩只生成草稿而不发送；console 0 error / 0 warning，且没有非静态请求。`expo install --check`、Expo Doctor 20/20、3 份 YAML、35 个 Bash `bash -n`、16 个官方 Action 完整 SHA、diff/密钥边界检查均通过。最终审计还覆盖保守 Unicode/emoji Token 门槛、ID/Unicode 往返、聚合存储预算 fail-closed、备份大小/Endpoint 密钥拒绝和原子导入。

干净 prebuild、`clean assembleRelease` 与正式证书本机签名通过。候选 APK 位于 `D:\EmbezzleStudio-Releases\v1.3.0-candidate\Embezzle-Studio-v1.3.0-candidate-release.apk`，97,448,407 字节，SHA-256 `c95dafe6e6eb77f3a1a4c7504c6ad05c27218b45972de2e247db264ec4c777d4`。包名/版本/code 为 `com.szdtzpj.embezzlestudio` / 1.3.0 / 9，min/target 24/36，`allowBackup=false`，有意 `RECORD_AUDIO`，无 CAMERA/`SYSTEM_ALERT_WINDOW`；只有一个预期正式签名者，证书 SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`，v2/v3 和 zipalign 通过。

PR [#13](https://github.com/szdtzpj/Embezzle-Studio/pull/13) 已合并为精确发布提交 `ea9409f1ea3540520eaf469a0c777fe1bc87e7f8`；PR Quality [`29176034579`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29176034579)、main Quality [`29176125303`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29176125303)、初始 Pages [`29176125307`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29176125307)、production Android [`29176245049`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29176245049) 和发布后 Pages [`29176763721`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29176763721) 均成功，tag `v1.3.0` 精确指向该提交。正式 Release 是 Latest、immutable、非 prerelease，Release attestation 与 3 个 asset attestation 均通过。

Actions 正式 `Embezzle-Studio-v1.3.0-release.apk` 为 97,448,407 字节，SHA-256 `b5e48387e62d99512ae18a2c4f4a80ddf482c3c1b489768e924845e0adceb7fe`；它与同尺寸但 SHA-256 为 `c95dafe6e6eb77f3a1a4c7504c6ad05c27218b45972de2e247db264ec4c777d4` 的本机候选不是同一字节。正式 APK 的包名/版本/code 为 `com.szdtzpj.embezzlestudio` / 1.3.0 / 9，min/target 24/36，`allowBackup=false`，有意 `RECORD_AUDIO`，无 CAMERA/`SYSTEM_ALERT_WINDOW`，单一预期 signer、证书 SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`，v2/v3 与 zipalign 通过。3 个正式资产另存于 `D:\EmbezzleStudio-Releases\v1.3.0`。

发布后 Pages manifest 与 `release.html` 匿名返回 200 且精确匹配 `v1.3.0`；完整公网 APK 已下载到 `D:\EmbezzleStudio-Releases\v1.3.0-pages-public-verify-20260712-103132`，大小与正式 SHA-256 完全一致。`adb devices -l` 仍为空，因此没有最终 Actions APK 的连接真机/额外机型或真实服务商账号计费验收。详细能力与安全边界见[本地知识与成果工作台](./docs/local-knowledge-workbench.md)，完整证据见[`1.3.0` 续作断点](./docs/CONTINUATION_CHECKPOINT_2026-07-12_V1.3.md)。

`1.4.0` / code 10 的本机候选门已通过：41 个测试文件 / 749 个测试、TypeScript/ESLint、3,264-module Web export（7.4 MB）、Expo Doctor 20/20、390×844 本地拦截浏览器 MCP 批准/拒绝/取消、YAML/Bash/Action-SHA/diff/敏感边界、干净 Android prebuild/未签名 Release、正式证书本机签名及 aapt/apksigner/zipalign 均通过。候选 `D:\EmbezzleStudio-Releases\v1.4.0-candidate\Embezzle-Studio-v1.4.0-candidate-release.apk` 为 97,518,039 字节，SHA-256 `683eb6e98efec3e301594e59c627b3698b410c2a58f841b3c3c3642b1a2a20ed`；包名/版本/code 为 `com.szdtzpj.embezzlestudio` / 1.4.0 / 10，min/target 24/36，`allowBackup=false`，无 CAMERA/悬浮窗，单一预期正式 signer、v2/v3 与 zipalign 通过。它尚未 push、tag、上传或发布，也没有连接真机或真实 OpenAI/MCP 账号验收；完整证据与外部边界见 [`1.4.0` 续作断点](./docs/CONTINUATION_CHECKPOINT_2026-07-12_V1.4.md)。

当前仓库已经创建 `Settings -> Environments -> android-release`、把 deployment branch policy 限制为 `main`，并配置了下列五个 Environment secrets；以下表格和命令同时作为环境重建或密钥轮换手册。若仓库/组织方案支持 deployment protection rules，还应启用 required reviewers 和 `Prevent self-review`。[GitHub Environments 官方限制](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)说明：Free、Pro 或 Team 方案的 required reviewers 只可用于公开仓库；私有仓库的 Environment secrets 和 deployment branches/tags 至少需要 Pro/Team，保持私有并获得 required reviewers 则需要 Enterprise。个人私有仓库的直接 collaborator 也没有可降级的 read 角色；当前按维护者决定，`BlueOcean223` 保留为明确受信任的 write collaborator，并接受没有双人审批的剩余风险。不要把“仅允许 `main` + owner workflow gate”描述成等价的双人审批。

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | release keystore 文件的 Base64 文本 |
| `ANDROID_KEY_ALIAS` | keystore 中的正式签名 alias |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_PASSWORD` | alias 私钥密码 |
| `ANDROID_SIGNING_CERT_SHA256` | 正式证书 SHA-256 指纹；带不带冒号均可 |

可以在仓库目录之外生成一次长期使用的 keystore：

```powershell
keytool -genkeypair -v `
  -storetype PKCS12 `
  -keystore "$HOME\embezzle-studio-release.p12" `
  -alias embezzle-studio `
  -keyalg RSA `
  -keysize 4096 `
  -validity 10000

$keystore = (Resolve-Path "$HOME\embezzle-studio-release.p12").Path
[Convert]::ToBase64String([IO.File]::ReadAllBytes($keystore)) | Set-Clipboard
keytool -list -v -keystore $keystore -alias embezzle-studio | Select-String 'SHA256'
```

把剪贴板中的 Base64 文本保存为 `ANDROID_KEYSTORE_BASE64`，并把 `keytool` 输出的 SHA-256 指纹保存为 `ANDROID_SIGNING_CERT_SHA256`。PKCS12 在 Android/JDK 工具链中的兼容路径要求 key password 与 store password 使用同一个高强度随机值，因此两个 GitHub Secret 应保存同一密码。不要把 keystore、Base64 文本或密码写入仓库、Release、Actions 日志或普通构建产物。请至少保留两份加密离线备份；丢失正式密钥后，已安装用户将无法原地升级到新签名的 APK。

每次发布按以下顺序操作：

1. 同步更新 `app.json` 的 `expo.version` 和递增的 `android.versionCode`、`package.json`/`package-lock.json` 的版本，以及 `src/data/appInfo.ts` 的版本。
2. 在本地通过与 CI 相同的质量检查，通过 Pull Request 合并到 `main`，再等待该合并提交的 Quality 与 push-triggered Pages 工作流都成功。
3. 暂停其它 `main` 合并和新版本 Release；从最新 `origin/main` 的精确提交创建并推送与下一应用版本一致的 tag，例如 `vX.Y.Z`。
4. 确认仓库已启用 Immutable Releases，由 `szdtzpj` 创建同名、非 prerelease 的空 draft Release，再从默认分支 `main` 手动运行 Android 工作流；不要提前发布空 Release。
5. 工作流会检出与当前 `origin/main` 完全相同的 tag 提交，生成未签名 APK，使用正式 keystore 签名，并在冻结前后重复核对 tag/main 提交以及每个 GitHub asset 的 digest、状态与 uploader，然后才把 draft 发布为 latest immutable Release。等该工作流、自动触发的 Pages 工作流、Release attestation 和公开 APK 字节校验都成功后，才结束发布冻结。

示例：

```powershell
git fetch origin
$mergeSha = git rev-parse origin/main
$releaseTag = 'vX.Y.Z'
git tag -a $releaseTag $mergeSha -m "Embezzle Studio $releaseTag"
git push origin $releaseTag
gh api --method PUT repos/szdtzpj/Embezzle-Studio/immutable-releases
gh release create $releaseTag --repo szdtzpj/Embezzle-Studio --verify-tag --draft --title "Embezzle Studio $releaseTag" --notes "Android production release $releaseTag."
gh workflow run android-apk.yml --repo szdtzpj/Embezzle-Studio --ref main -f release_tag=$releaseTag
```

Release 标题、正文与发布时间会被复制到公开 Pages 清单和下载页。创建 draft 前必须把这些文字当作公开内容审阅，不得包含私有仓库、账号、客户或密钥信息；不要未经检查直接使用自动生成的 release notes。

`v1.0.3` 及更早版本和 `v1.0.4-debug.*` 预发布使用生成的 debug 签名，只能作为测试安装包，不能作为正式发布签名的信任起点。迁移到正式 `v1.0.4` 或后续版本前应先导出重要数据，再卸载测试包（会清除应用本地数据）并安装正式 APK；Android 不允许用新的正式证书直接覆盖这些 debug-signed 安装。

应用内更新检查不会携带 GitHub Token。私有仓库的 Releases API 和下载页对普通安装用户会返回 `404`，因此签名发布成功后，Pages 工作流会自动重新运行，并通过 `scripts/stage-release-for-pages.mjs` 处理最新稳定 Release。脚本只接受由仓库所有者发布的 GitHub Immutable Release，以及由 `github-actions[bot]` 上传、状态为 uploaded、带 GitHub SHA-256 digest 的精确 APK/校验文件；随后仍会自行下载字节、复算两个 asset digest，并把校验条目精确绑定到 `Embezzle-Studio-${tag}-release.apk`。全部一致后才暂存公共 APK、生成 `release.html`，并让清单 `releaseUrl` 指向该页。

缺少预期 APK/校验文件，或 Release/asset 的来源 URL、状态、uploader、digest 元数据不满足信任条件时，脚本只生成 `apk: null` 的 fail-closed 清单并撤下旧的受管下载输出；实际下载字节与 GitHub digest/校验文件不一致，或 APK 超过 256 MiB、校验文件超过 64 KiB 时才会使 Pages 构建失败。响应声明大小和实际流式读取字节都会受限。下载页也明确说明：Immutable Release、GitHub asset digest 与校验文件仍不替代工作流中的 `apksigner` 正式证书校验。客户端固定读取公共清单，只接受本仓库精确 GitHub Release 路径或 `https://szdtzpj.github.io/Embezzle-Studio/` 下受限路径；只有同时得到可信安装资产且版本更高时才提示可更新，并在设置页展示摘要后打开可信发布页，不会直接安装 APK。不要把 GitHub PAT 内置到客户端。

GitHub Release 的多个资产上传不是事务操作。工作流仅在 owner-authored 空 draft 上上传；失败时会尝试删除由 `github-actions[bot]` 写入的预期部分资产，其他 uploader 或无法自动清理的状态仍需维护者人工核对。draft 的三个资产全部核验后才发布，发布后还会对 immutable 快照的 refs、精确资产集合、digest、状态与 uploader 做一次后验复核。GitHub 随后锁定 Release 的 tag/资产并生成 attestation；不要为了自动重试而允许覆盖已发布资产。

## 文档

- [Product and Architecture](./docs/product-architecture.md)
- [Provider Protocol Matrix](./docs/provider-protocols.md)
- [BYOK Productivity Suite](./docs/byok-productivity-suite.md)
- [Roadmap](./docs/roadmap.md)
