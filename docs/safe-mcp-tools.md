# v1.4 安全 MCP 工具

最后核验：2026-07-12。

Embezzle Studio 的 MCP 目标不是“只要服务商支持就自动调用”，而是在移动端建立一个可检查、可拒绝、默认关闭的逐次审批边界。v1.4 只开放已经有官方审批契约且能够保持本地上下文管理的路径；服务商能力标签、已保存的 MCP 配置或“已授权”状态，都不能单独启用工具执行。

## 产品与计费边界

- MCP 继续采用 BYOK。模型请求使用用户配置的服务商 Endpoint、账号和 API Key；远程 MCP 的授权也由用户提供。Embezzle Studio 不购买、转售、补贴或汇集模型与工具额度。
- 应用不建设模型代理、MCP 网关、审批服务器、任务服务器或计费服务器。设备只请求用户选择的模型服务商，由服务商代表该用户连接公网远程 MCP Server。
- 所有模型 Token、供应商工具费、MCP Server 费以及 MCP 背后第三方 API 的费用都由用户自己的账号承担。即使服务商不另收 MCP 调用费，模型 Token 和第三方服务仍可能计费。
- v1.4 不支持本地 stdio MCP、设备直连 MCP、局域网或私网 MCP，也不在应用内启动 MCP 进程。只接受无内嵌凭据、无查询参数、无片段、非私网地址的公网 HTTPS Endpoint。

## v1.4 服务商范围

### OpenAI：本地实现已开放，真实账号验收待完成

OpenAI Responses API 已正式定义 `mcp_approval_request` 和 `mcp_approval_response`。v1.4 的 OpenAI 实现保持 `store: false`，不依赖 `previous_response_id`：

1. 首次请求发送非空 `allowed_tools`、`require_approval: "always"` 和用户输入。
2. 客户端在本机保存原始输入与首轮完整 `output`，包括 `mcp_list_tools`、reasoning 项和 `mcp_approval_request`，不能只保存最终文本。
3. 收到审批请求后暂停，展示 MCP Server、工具名、完整参数和拟发送数据。
4. 用户批准或拒绝后，新建第二个 `store: false` Response，把原始输入、首轮全部输出项和对应 `mcp_approval_response` 作为手动上下文发送，并重复发送完全相同的模型与 MCP 工具定义。
5. 若推理模型需要跨请求保留推理状态，按官方手动上下文指引请求并回传 `reasoning.encrypted_content`；reasoning 项缺少可用密文、`mcp_list_tools` 同时带错误和工具列表、重复的 Response/审批/调用 ID、未知项或无法关联的审批都必须终止本轮。

运行时不仅核对域名，还要求服务商类型是专用的 `openai-compatible`、Endpoint inspection 规范化结果精确等于 `https://api.openai.com/v1`，并拒绝自定义端口与异常路径。Android 原生请求设置 `redirect: "error"`；本机 Web 调试代理也由代理端固定拒绝上游重定向，客户端不能放宽该策略。

OpenAI 不会保存 MCP 工具配置中的 `authorization` 值，也不会在 Response 对象中返回它，因此每次创建 Response 都要从本机安全存储重新注入。授权值不得进入对话记录、审批文本或诊断日志。`store: false` 只控制 Responses 对象存储，不代表服务商安全日志、OpenAI 组织数据控制或远程 MCP Server 自身的日志与保留政策也被关闭；这些外部政策仍需用户逐一核对。

官方依据：[OpenAI MCP 与 Connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)、[Create Response 字段](https://developers.openai.com/api/reference/resources/responses/methods/create)、[Responses 流事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)、[手动管理 conversation state](https://developers.openai.com/api/docs/guides/conversation-state#manually-manage-conversation-state)。

### 火山方舟：保留配置，运行时关闭

Ark 官方协议已经提供 `require_approval: "always"`、`allowed_tools.tool_names`、`mcp_approval_request`、`mcp_approval_response` 和 `previous_response_id` 续接；测试期间还要求每次请求携带 `ark-beta-mcp: true`，并且当前只支持 Streamable HTTP MCP。

但是，官方 MCP 示例使用 `previous_response_id`。Ark Responses 的 `store` 默认开启，而 `store: false` 的响应不能被后续 API 检索；当前官方文档尚未明确证明 MCP 审批可以像 OpenAI 一样在 `store: false` 下完整手动回放。v1.4 因此继续允许安全保存 Ark MCP 配置，但不发送 MCP 工具请求。只有真实 Ark 账号完成以下验证后，才能另行开放：

- `store: false` 首轮审批请求可由完整本地上下文安全续接；
- 批准与拒绝路径均能关联到唯一审批请求；
- 非空工具白名单确实生效，白名单外工具不会执行；
- 流式列表、参数、完成、失败和取消事件都能 fail-closed；
- 同一授权不会跨服务商、Endpoint、传输协议或 MCP Server 复用。

若未来只能依赖 Ark 服务端存储，则必须先增加清晰的数据保留说明和用户显式同意，不能把普通“启用 MCP 配置”视为同意存储会话。

官方依据：[Ark 云部署 MCP / Remote MCP](https://www.volcengine.com/docs/82379/1827534)、[Ark 创建 Responses 模型请求](https://www.volcengine.com/docs/82379/1569618)、[Ark 上下文管理](https://www.volcengine.com/docs/82379/2123288)。

### 阿里百炼：保留配置，运行时关闭

百炼 OpenAI-compatible Responses 文档只列出 MCP 的 `type`、`server_protocol`、`server_label`、`server_url`、可选 `server_description` 和 `headers`。同一文档明确说明，只有列出的兼容参数会被处理，未列出的 OpenAI 参数会被忽略；当前没有列出 `require_approval`、`allowed_tools`、`mcp_approval_request` 或 `mcp_approval_response`。

百炼当前公开的 Responses 流程会从 `response.mcp_call_arguments.delta/done` 直接进入 `mcp_call` 执行与完成，客户端没有执行前暂停点。因此不能通过附加一个未受支持的 `require_approval: "always"` 字段来假装安全，也不能在工具执行后再用本地弹窗补做审批。

百炼另有 Managed Agents Session/Event API，其概览提到工具审批，但这是要求预先创建 Agent、Environment 和 Session 的另一套有状态产品；当前公开的 Send Event 字段文档也没有给出完整的工具审批事件类型、审批 ID、决定字段和往返示例。它不是当前 Responses 适配器可直接采用的等价契约。

官方依据：[百炼 Create a response](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-responses)、[百炼 MCP](https://help.aliyun.com/en/model-studio/mcp)、[百炼 Session/Event 概览](https://help.aliyun.com/en/model-studio/session-api/)、[百炼 Send Event](https://help.aliyun.com/en/model-studio/event-post)。

## 工具白名单与逐次审批

- `allowedTools` 必须是去重后的非空精确工具名列表。名称按当前 MCP Tools 规范限制为 1–128 个 ASCII 字符，只接受字母、数字、下划线、连字符和点；空列表、仅空白项、通配符和“导入服务器全部工具”都不能进入执行路径。[MCP Tools 规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- 每个 `mcp_approval_request` 都必须单独审批，不提供“本次全部同意”“记住选择”或自动批准。多工具、多轮或并行请求必须按唯一审批 ID 分别关联。
- 审批页至少展示：服务名称、规范化 Endpoint 的 origin、工具名、完整 JSON 参数、拟发送给第三方的数据、当前模型服务商，以及“工具可能修改外部状态”的固定警告。
- 参数必须在最终 `done` 事件后解析和展示；增量参数只用于组装，不能据此提前审批。畸形 JSON、超限参数、白名单外工具、服务商或 Endpoint 变化、重复审批 ID、缺失事件及未知事件一律拒绝并取消本轮。
- 拒绝不是零费用操作。向服务商发送 `approve: false` 仍是一次新的模型请求，可能产生额外 Token 费用；模型也可能改为回答、提出另一个工具请求或再次请求审批，后续每次仍需单独确认。
- 用户选择“取消整轮”时，不再发送审批续接请求，并取消仍在进行的网络请求。取消不能撤销首轮已经产生的模型费用，也不能撤销在取消前已经由服务商或远程工具完成的副作用。

## 副作用与信任边界

- 审批的是展示出来的这一次工具名和参数，不是对 MCP Server 的永久信任。服务器实现、工具描述或行为以后可能变化。
- 远程工具可能写文件、发消息、创建订单、修改账号、触发工作流、公开内容或产生第三方费用；“看起来只读”的名称不能代替服务端保证。
- MCP Server 返回的文本、链接和媒体 URL 都是不可信输入，可能包含提示注入或恶意地址。应用不得自动打开、下载或把返回 URL 再发送到其他服务。
- 优先使用服务提供方自己运营的 MCP Server。第三方聚合器会额外获得参数、上下文和授权信息，必须在每次审批页清楚显示实际 Endpoint。

## 凭据、备份与日志

- Provider API Key 与 MCP authorization 继续写入操作系统安全存储，并绑定 provider ID、provider kind、规范化 Base URL、MCP 类型、传输协议和规范化 Endpoint。
- MCP authorization、API Key、完整认证 Header、带密钥 URL、媒体字节和审批运行时状态不得进入明文或加密工作区备份。
- 加密备份导入后，所有远程 MCP 配置一律恢复为关闭状态；即使备份记录为已启用，也必须在当前设备重新检查并手动启用。内部存储加载 Ark、百炼、自定义服务商或非规范 OpenAI 路由绑定时同样强制关闭。
- 日志只能记录脱敏后的 provider/server 标识、工具名、审批结果、错误分类和本地关联 ID；不得记录 Authorization、Cookie、API Key、完整工具输出或可能含秘密的完整参数。
- 对话可在本机保存有界的 MCP 活动摘要，只包含服务标签、发送前登记的请求尝试数、工具名、批准/拒绝和完成/失败/不确定状态；不保存参数、输出、Authorization 或 provider/request/call/approval ID。请求尝试数是保守保险丝证据，不冒充服务商实际接收数或账单。该摘要与本机费用账本一样不进入可移植备份。
- 请求若在批准并发出续接后中断，活动摘要必须标记“结果不确定”，提醒外部副作用可能已经发生；不能把 Abort 或网络失败描述为已撤销工具操作。
- 崩溃恢复不得自动重放“批准”。审批只对当前内存中的唯一请求有效；应用重启、超时、模型切换、服务商切换或 Endpoint 修改后必须作废。

## 与现有模式互斥

- 安全 MCP 首版与多模型 comparison 互斥。comparison 会并行产生多份独立服务商请求，无法在当前移动端可靠地把每个审批、费用和取消动作绑定到唯一分支。
- 安全 MCP 首版与 provider-hosted web search 互斥。联网搜索已经是独立的 Responses 工具路由；首版不在同一轮混合搜索与 MCP，以免参数、引用、工具费用和审批状态相互混淆。
- 图片/视频生成、语音、嵌入、重排和其他专用任务不启用 MCP。只有通过能力矩阵、协议检查和上述安全门的普通对话模型可以进入 OpenAI MCP 路由。

## 发布结果与剩余验收门槛

v1.4 的自动化发布门槛已经完成：41 个测试文件 / 749 个测试覆盖批准、拒绝、取消、多审批、白名单外工具、畸形参数、未知输出项、列表失败、调用失败、重复/过期审批 ID、认证脱敏、`store: false` 完整手动续接、comparison/web-search 互斥，以及应用重启后不得重放审批。PR #15 的 head 为 `1176df7964712078d58c5eade50d781a8245d52e`，合并后的 `main` 与 tag `v1.4.0` 均为 `f83cea7fae36fcbaa0bff361fac2113c3edfb3d7`；PR Quality `29182946741`、main Quality `29183001171`、tag 前 Pages `29183001176`、production Android `29183097617` 和发布后 Pages `29183525831` 均成功。

正式 [`v1.4.0` Release](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.4.0) 是 stable Latest、immutable、非 prerelease，并含 3 个由 `github-actions[bot]` 上传且通过 attestation 的资产。正式 APK 位于 `D:\EmbezzleStudio-Releases\v1.4.0`，大小 97,518,039 字节，SHA-256 `c650e142e221821f8da91e37fefd76dad0e7ad94c0348a3d7749b69f14fc67eb`；它与同大小但 SHA-256 为 `683eb6e98efec3e301594e59c627b3698b410c2a58f841b3c3c3642b1a2a20ed` 的本机 candidate 不同。正式 APK 的包名/版本/code 为 `com.szdtzpj.embezzlestudio` / 1.4.0 / 10，min/target 24/36，`allowBackup=false`，有意 `RECORD_AUDIO`，无 CAMERA/`SYSTEM_ALERT_WINDOW`，只有证书 SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02` 的单一 signer；v2/v3 与 zipalign 通过。

发布后 Pages manifest、`release.html`、APK `HEAD` 和完整 APK 下载均可匿名 HTTP 200 访问并与 Release 字节一致；完整公网复核副本位于 `D:\EmbezzleStudio-Releases\v1.4.0-pages-public-verify-20260712-150424`。GitHub 发布链路已经完成，不再是待办项。

`adb devices -l` 仍为空，因此仍必须用用户自己的真实 OpenAI 账号和可信测试 MCP Server 在真机完成一次只读调用、一次明确拒绝、一次取消和一次可观察但可逆的写操作，并对照服务商日志与账单。Ark 与百炼的配置界面可以保留，但在各自门槛满足前，能力矩阵、按钮状态、文档和错误提示都必须继续明确显示“仅保存配置，工具执行关闭”。
