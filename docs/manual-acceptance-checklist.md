# Embezzle Studio 真实 API 与 Android / Web 真机手动验收清单

> **适用版本**：`v2.0.0`（生态升级、多协议原生适配、全端交互稳定性与 Tier 5 安全加固）
> **目标设备**：Android 真机（建议 Android 13–15 全面屏 / 物理调试机）+ 桌面/移动浏览器（Chrome / Edge 最新版）
> **安全红线**：本清单涉及真实第三方 API Key 调试时，所有测试密钥仅保存在本机或调试环境变量中，严禁提交到仓库；正式 Web 静态构建（`dist/`）在无受控本机代理授权时必须强制 fail-closed 拦截任何外发模型/搜索请求。

---

## 一、前置准备与环境基线

### 1.1 自动化工程基线核验
- [ ] **A1. 全量静态检查与单元测试基线通过**
  - **前置条件**：已在仓库根目录 `c:\Python_project\Embezzle-Studio` 完成 `npm ci`，Node.js >= 20 LTS。
  - **操作步骤**：
    1. 执行 `npm run check`（依次执行 `typecheck`、`lint`、`test`）。
    2. 执行 `npm run build:web && node tests/verify-web-dist-bundle.mjs` 生成并校验生产静态构建产物 `dist/`。
  - **预期结果**：`npm run check` 退出码为 `0`（0 TypeScript errors、0 ESLint warnings、全部 Vitest 用例通过）；`dist/` 成功生成且 `verify-web-dist-bundle.mjs` 输出检查全通。
  - **常见失败回退排查**：若 `tsc` 报内存不足，确认未去掉 `package.json` 中的 `--stack_size=16384`；若 `dist/` 校验失败，删除 `dist/` 目录并重新执行 `npm run build:web`。

### 1.2 Web 本机调试与生产静态托管基线
- [ ] **A2. 启动 Web 调试双进程（Expo Web + 受限 Dev Proxy）**
  - **前置条件**：本地端口 `8081` 与 `8787` 未被占用。
  - **操作步骤**：
    1. 执行 `npm run web`（内部调用 `scripts/start-web.mjs`，同时启动 `scripts/dev-proxy.mjs` 与 `npx expo start --web`，并注入 `EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY=1`）。
    2. 浏览器访问 `http://localhost:8081`（或 `http://127.0.0.1:8081`）。
  - **预期结果**：终端显示 Dev Proxy 监听 `127.0.0.1:8787` 且 Expo Metro 打包就绪；浏览器首屏无白屏、DevTools Console 无未捕获异常。
  - **常见失败回退排查**：若仅需单独启动 Expo Web 或代理排查，可拆开在两个终端运行 `npm run web:proxy` 与 `EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY=1 npm run web:expo`；切勿使用 `0.0.0.0` 暴露调试代理到公网。

### 1.3 Android 真机调试 / Release APK 安装基线
- [ ] **A3. Android 真机 USB 调试或安装包就绪**
  - **前置条件**：已安装 Android SDK (`adb`)，真机已开启“开发者选项 -> USB 调试”，连接电脑后 `adb devices` 显示 `device`。
  - **操作步骤**：
    1. 开发态直连调试：执行 `npm run android`（或 `npx expo run:android`）安装 Debug 包并连接 Metro；或通过 GitHub Actions / 本地 Gradle 构建 Release APK 后执行 `adb install -r app-release.apk`。
    2. 使用 `adb logcat *:E` 观察启动期日志。
  - **预期结果**：应用冷启动直接进入主工作区对话界面，Splash Screen 平滑退出，无原生崩溃或 `ReactNativeJS` 致命异常。
  - **常见失败回退排查**：若 Metro 连接超时，运行 `adb reverse tcp:8081 tcp:8081`；若遇到旧版本本地存储结构冲突，先清除应用数据或卸载重装后验证迁移逻辑。

---

## 二、R1 主流模型直连、网络搜索与中转 / Headers / Auth 验收

> **说明**：Web 端验收须在 `npm run web`（受控本地代理 `127.0.0.1:8787/proxy`）下进行；Android 真机直连公网 HTTPS 上游。

### 2.1 OpenAI GPT-5 / GPT-4.1 / Responses 协议
- [ ] **R1-1. OpenAI Responses 流式推理摘要与内置 `web_search` 引用**
  - **前置条件**：设置页配置官方 `OpenAI`（`https://api.openai.com/v1`）及有效 `API Key`，拉取并启用 `gpt-5.4`（或 `gpt-5`）与 `gpt-4.1`。
  - **操作步骤**：
    1. 选中 `gpt-5.4`，将推理强度设置为 `medium` 或 `high`，开启输入栏**服务商联网搜索**开关。
    2. 发送时效性问题（例如：“查询今日最新国际财经要闻并列出官方来源”）。
    3. 切换到非推理模型 `gpt-4.1` 发送普通问答。
  - **预期结果**：
    - `gpt-5.4` 实时流式展示 Thinking 区域（来自 `response.reasoning_summary_text.delta`）与状态时间线（正在联网检索 -> 检索完成），正文内出现 `[1]` 内联引用胶囊，底部横向抽屉显示可点击的 `HTTPS` 来源卡片；
    - `gpt-4.1` 请求体不携带 `reasoning` 字段（可通过 Dev Proxy 日志或网络抓包确认），正常流式回复。
  - **常见失败回退排查**：若组织未开通 `reasoning.summary` 权限导致 400，检查错误提示是否对 `API Key` 脱敏且未暴露密钥；若中转站不支持 `/v1/responses`，改用“New API 中转”或“Custom OpenAI”配置。

### 2.2 Anthropic Claude 原生 `/v1/messages` 协议
- [ ] **R1-2. Claude 原生 Thinking + `signature` 多轮无损回传 + `web_search_20250305`**
  - **前置条件**：设置页配置官方 `Anthropic`（`https://api.anthropic.com/v1`）及有效 `API Key`，选择 `claude-sonnet-4` / `claude-opus-4` / `claude-3-7-sonnet` 或 `claude-sonnet-5-5`。
  - **操作步骤**：
    1. 开启推理强度（非 `off`）及服务商联网搜索，发送：“对比 2026 年主流开源协议变更趋势，先深度思考再联网核查”。
    2. 首轮完成后，同一会话继续追问第 2 轮：“基于你刚才思考的第二点继续展开细节”。
  - **预期结果**：
    - 请求头自动携带 `x-api-key` 与 `anthropic-version: 2023-06-01`，无 `Authorization` 头冲突；
    - 流式事件无 `[DONE]` 仍以 `message_stop` 正常结束，Thinking 自动折叠；
    - 第 2 轮追问成功返回 200，无 `Invalid signature in thinking block` 错误（验证 `thinking.signature` 与 `redacted_thinking.data` 已原样回传）。
  - **常见失败回退排查**：若返回 400 提示采样参数冲突，确认思考开启时应用未向服务端发送 `temperature` / `top_p` / `presence_penalty`；若 400 提示 `anthropic-beta`，检查自定义头中没有空逗号残留。

### 2.3 Google Gemini 原生 `streamGenerateContent` 协议
- [ ] **R1-3. Gemini 2.5 / 3.x Thinking 与 `google_search` Grounding**
  - **前置条件**：设置页配置官方 `Google Gemini`（`https://generativelanguage.googleapis.com/v1beta`）及有效 `API Key`，选用 `gemini-2.5-pro` 或 `gemini-2.5-flash`（及 3.x 预设）。
  - **操作步骤**：
    1. 开启思考配置与服务商联网搜索，发送需要实时检索的问题（例如：“检索 React Native 0.86 最新变更日志要点”）。
    2. 检查请求 URL 与请求头（确认密钥仅通过 `x-goog-api-key` 头传输，未拼在 `?key=` URL 查询参数中）。
  - **预期结果**：流式 `streamGenerateContent?alt=sse` 正常解析 `thought` 思考块、`groundingMetadata.groundingChunks` 来源卡片以及内联 `groundingSupports` 引用标记；即使模型返回含 `thoughtSignature` 也能在多轮对话安全续接。
  - **常见失败回退排查**：若用户填入 `/v1beta/openai` 兼容路径，设置保存时应自动规范化并提示；若某地区节点禁用 `google_search`，应清晰展示服务端错误且不泄漏 `AIza...` Key。

### 2.4 xAI Grok 一等对话与搜索协议
- [ ] **R1-4. xAI Grok `grok-4.7` / `grok-4.3` 与 `web_search` / `x_search`（确认无 410 错误）**
  - **前置条件**：设置页配置官方 `xAI Grok`（`https://api.x.ai/v1`）及有效 `API Key`，启用 `grok-4.7` 或 `grok-4.3`。
  - **操作步骤**：
    1. 开启服务商联网搜索，发送同时涉及全网与 X 平台动态的问题（例如：“查看今日 xAI 官方 X 动态与最新模型发布信息”）。
    2. 进行第 2 轮追问验证多轮续接。
  - **预期结果**：
    - 请求发往 `/v1/responses`，携带 `tools: [{"type":"web_search"},{"type":"x_search"}]` 与 `include: ["reasoning.encrypted_content"]`，**绝不发送已废弃的 `search_parameters`**，无 HTTP `410 Gone`；
    - 引用链接标题经过美化（无裸 `"1"`、`"[2]"` 弱标题），第 2 轮正确回传 `encrypted_content`。
  - **常见失败回退排查**：若连接的是不支持 `/v1/responses` 的第三方中转（返回 404/405/501），应用应自动取消响应体并平滑降级到 `/v1/chat/completions`。

### 2.5 DeepSeek 双轨联网搜索与外部独立搜索生态
- [ ] **R1-5. DeepSeek 官方直连联网 (`deepseek_web_search` + `deepseek_read_url`) 与中转降级隔离**
  - **前置条件**：分别配置（A）官方 `DeepSeek`（`https://api.deepseek.com/v1`）与（B）任意第三方中转站（例如 `kind: 'deepseek'` 或 `'new-api-relay'`，但 `baseUrl` 为 `https://relay.example.com/v1`）。
  - **操作步骤**：
    1. 在配置（A）官方 DeepSeek 选择 `deepseek-chat` / `deepseek-reasoner` / `deepseek-v4-pro` / `deepseek-flash`，验证模型卡片出现“联网搜索”能力标识，开启后发送实时新闻查询并追问一轮。
    2. 切换到配置（B）中转站并添加同名模型 `deepseek-v4-pro`，检查能力徽标与搜索开关。
  - **预期结果**：
    - 配置（A）官方直连成功触发服务端工具调用与网页读取，时间线展示检索进度，多轮续接无损回传 `server_tool_calls`；
    - 配置（B）非官方中转站上的 `deepseek-v4-pro` **不会误标为支持官方 `web-search`**，避免触发中转站报错或无效计费。
  - **常见失败回退排查**：若中转站需要使用搜索，请在“外部独立搜索”中开启 `search_web` Tool Calling 闭环。

- [ ] **R1-6. 外部独立搜索（DeepSeek `/v1/tools/search` / Bocha / Exa / SearXNG）**
  - **前置条件**：在“设置 -> 外部搜索”分别配置并启用：DeepSeek Search（需 Key）、Bocha 博查（需 Key）、Exa AI（需 Key）、自托管 SearXNG（需公网 HTTPS 且已开启 `format=json`，无需 Key）。
  - **操作步骤**：
    1. 依次切换激活上述外部搜索服务，配合任意支持 Tool Calling 的聊天模型发送时效性问题。
    2. 故意输入指向内网/非 443 端口的 SearXNG 地址（如 `https://192.168.1.1/search`、`https://searx.example.com:8443/search` 或 `http://searx.example.com`）尝试保存。
  - **预期结果**：
    - 正常启用时，聊天界面时间线依次展示 `search_web` 运行中 -> 返回 N 条结果，模型正文出现可点击引用角标，底部展示来源卡片；
    - 非法内网/非 443 端口/明文 HTTP Endpoint 在保存或调用前即被 SSRF 策略拦截并给出明确中文提示；
    - 若 SearXNG 未开启 `format=json` 返回 HTML，提示明确的 `settings.yml` 配置指引。
  - **常见失败回退排查**：确认“服务商内置联网搜索”与“外部搜索”互斥边界提示清晰，不能在单次请求中同时发送两套机制冲突。

### 2.6 自定义 Headers 与 Auth 模式切换
- [ ] **R1-7. 自定义 Headers（含 `Content-Type` 保护）与 Auth 模式（`auto` / `bearer` / `x-api-key` / `x-goog-api-key` / `custom`）**
  - **前置条件**：打开设置页某中转或自定义服务商详情。
  - **操作步骤**：
    1. 在“自定义请求头”添加合法业务头（如 `X-Tenant-Id: team-a`）以及敏感头（如 `X-Relay-Secret: sec-123`），观察掩码切换与敏感提示。
    2. 尝试添加被禁止的系统/协议头：`Host`、`Cookie`、`Proxy-Authorization`、`X-Forwarded-For`、`Content-Type`。
    3. 将 Auth 模式切换为 `custom` 并删除或置空所有自定义头名称，点击“检查连接 / 刷新模型”。
    4. 填写有效的自定义鉴权头后重新拉取模型并发送一条对话。
  - **预期结果**：
    - `Host`、`Cookie`、`Content-Type` 等受限头在表单校验与运行时均被明确阻断，**协议头 `Content-Type: application/json` 不会被覆盖**；
    - `custom` 模式下缺少有效已启用的非空名/非空值请求头时，刷新模型直接给出中文引导提示且**不发网络请求**；
    - 填好有效自定义头后刷新与对话请求均只携带该自定义鉴权头（不重复注入默认 `Authorization`）。
  - **常见失败回退排查**：清空所有自定义头并保存后，重启应用确认旧的 `customHeaders` 不会重新复活残留。

---

## 三、R2 生图能力与现代化交互验收

### 3.1 全协议文生图与图生图闭环
- [ ] **R2-1. 多厂商生图模型调用与参数面板联动**
  - **前置条件**：分别配置并选中 OpenAI（`gpt-image-1.5` 或 `gpt-5` Responses `image_generation`）、Google Gemini（`gemini-2.5-flash-image` / `gemini-3.1-flash-image`）、xAI Grok（`grok-imagine-image-2.0`）、火山方舟 Seedream / 阿里百炼 Wanx，以及 Anthropic Claude 对话模型。
  - **操作步骤**：
    1. 选中生图模型时，观察输入栏上方自动浮现的**生图参数面板**（比例 `aspectRatio`、画质/分辨率 `quality`/`resolution`、张数 `count`）。
    2. 设定参数（如 `16:9`、高画质）并输入提示词“一只穿宇航服的柴犬站在月球表面，电影感逆光”生成图片。
    3. 附加 1 张本地参考图执行图生图：分别测试 OpenAI `/v1/images/edits`（`multipart/form-data`）、xAI `/v1/images/edits`（JSON）、Gemini 原生图生图。
    4. 选中不支持原生效能直出光栅图的 Anthropic Claude 模型进入参数/引导入口，验证界面明确给出切换生图模型引导而不盲目发起失败请求。
  - **预期结果**：各协议均按官方契约构造请求并成功渲染返回的生成图片；参数切换在当前会话内持久生效。
  - **常见失败回退排查**：若中转站对 `gpt-image` 仅支持 `/v1/images/generations` 而不支持 Responses `image_generation`，在设置页将 `imageApiMode` 显式切换为 `openai-images`。

- [ ] **R2-2. 对话内“以此图继续编辑”与 Gemini `thoughtSignature` 多轮改图**
  - **前置条件**：已在对话内生成一张图片（优先使用 Gemini `gemini-2.5-flash-image` 产生带 `thoughtSignature` 的结果）。
  - **操作步骤**：
    1. 点击消息内生成图片上的“以此图继续编辑”快捷动作（或在全屏灯箱中点击“以此图继续编辑”）。
    2. 观察模型切换与草稿附件载入情况，输入修改指令：“把背景改为极光星空并保留主体”。
    3. 发送后核验新生成图片及多轮修改连续性。
  - **预期结果**：点击后自动切换至推荐生图模型（如当前为聊天模型），**参考图附件稳定载入输入框不被异步草稿清理覆盖**，多轮修改保持主体一致性且 `thoughtSignature` 无损回传。
  - **常见失败回退排查**：若快速连续切换不同模型后点击编辑，核对输入框上方附件缩略图与待发模型一致。

### 3.2 图片全屏灯箱与富媒体交互
- [ ] **R2-3. 图片全屏灯箱（缩放查看、保存与继续编辑）**
  - **前置条件**：对话中存在已加载的图片消息。
  - **操作步骤**：
    1. 点击图片进入全屏灯箱 `ImageLightboxModal`。
    2. 执行双击缩放 / 双指捏合缩放与拖拽平移（Android）或点击放大/缩小控件（Web）。
    3. 点击“保存图片”并授权存储权限（Android）或触发浏览器下载（Web）。
    4. 点击右上角关闭或 Android 物理返回键退出灯箱。
  - **预期结果**：缩放流畅无撕裂，保存成功后弹出 Toast 提示，退出灯箱后无透明遮罩残留且页面可正常点击。
  - **常见失败回退排查**：Android 13+ 媒体保存若弹出系统权限弹窗，拒绝后应弹出友好引导提示而非崩溃。

- [ ] **R2-4. Thinking 实时计时与折叠、内联引用胶囊、代码块高亮与 LaTeX 公式**
  - **前置条件**：使用支持推理与搜索的模型发起一条包含思考、联网引用、多语言代码与数学公式的提问（例如：“推导快速傅里叶变换时间复杂度并附 TypeScript 实现和在线参考链接”）。
  - **操作步骤**：
    1. 观察模型输出思考过程期间的实时计时 badge（例如 `思考中 2.3s`），并在正文开始输出后观察自动折叠行为。
    2. 点击消息内嵌 `[1]` 角标胶囊与底部来源抽屉卡片，验证跳转与原文摘录。
    3. 检查代码块语言标签栏、语法高亮配色与右上角“一键复制”按钮；检查行内 `$O(n \log n)$` 与块级 `$$\sum ...$$` LaTeX 公式排版。
  - **预期结果**：思考完成后自动折叠且保留精确耗时（如 `已深度思考 (3.4s)`），支持手动展开/收起；代码块支持横向滚动与一键复制（Toast 提示“已复制”）；LaTeX 公式清晰排版无原始转义乱码。
  - **常见失败回退排查**：若极长代码块在窄屏撑破气泡宽度，检查外层容器是否启用横向滚动约束。

- [ ] **R2-5. 会话导出（Markdown / JSON 脱敏）、Web 快捷键与 `/` 快捷指令浮层**
  - **前置条件**：当前会话至少包含一条正常对话与一条含模拟错误报文（测试用假凭据如 `Authorization: Bearer test-secret-123` 或 JSON 转义凭据）的异常消息；另外准备一个刚删除全部对话后的工作区场景。
  - **操作步骤**：
    1. 在输入框键入 `/`，验证 `/` 快捷指令浮层弹出；使用方向键或点击选择指令（如插入提示词模板、`/export` 导出等）。
    2. 在 Web 端中文输入法（IME 拼音组合状态，按下 `Enter` 上屏候选词）下敲击 `Enter`；上屏确认后按 `Shift+Enter` 换行；最后直接按 `Enter` 发送。
    3. 点击顶部导出按钮或使用 `/export` 分别导出 Markdown 与 JSON，检查导出文件内容。
    4. 在左侧抽屉删除最后仅存的一条对话后，立即点击顶部导出按钮与 `/export`。
  - **预期结果**：
    - 中文 IME 组合输入中按 `Enter` **不会误发送消息**；`Shift+Enter` 正确换行；非空且非组合态按 `Enter` 发送成功；
    - 导出文件中错误信息里的 `Bearer` 与多层转义 `x-api-key` 等凭据均已被替换为 `[redacted]`，而正常正文技术文档示例保留原样；
    - 删除最后一条对话后系统自动初始化有效空对话，顶部导出按钮与 `/export` 依然可用不失效。
  - **常见失败回退排查**：Web 下载若被浏览器弹窗拦截器阻止，检查是否在同一用户点击事件同步链路内触发 `a.click()`。

---

## 四、R3 Android 真机与 Web 端稳定性 / 安全边界验收

### 4.1 Android 真机 UI 避让、安全区、弹窗队列与手势
- [ ] **R3-1. Android 软键盘单层避让与 `MainWorkspaceTabBar` 自动隐藏**
  - **前置条件**：Android 真机竖屏打开主对话页，底部可见主工作区 TabBar 与输入框。
  - **操作步骤**：
    1. 点击底部输入框唤起系统软键盘（中文九宫格/全键盘均可）。
    2. 键入多行文本（1–6 行）并观察输入框与消息列表底部间距。
    3. 收起软键盘。
  - **预期结果**：软键盘弹出时底栏 `MainWorkspaceTabBar` 自动隐藏，输入框紧贴软键盘上方，**无双重向上挤压或大面积空白间隙**，也无输入框被键盘遮挡；收起键盘后 TabBar 平滑恢复且底部不出现双倍导航栏安全区留白。
  - **常见失败回退排查**：确认 `app.json` Android `softwareKeyboardLayoutMode` 为 `"resize"`，且页面根容器未叠加多余 `KeyboardAvoidingView padding`。

- [ ] **R3-2. Edge-to-Edge 状态栏/刘海/全面屏手势导航栏安全区核验**
  - **前置条件**：在带挖孔屏/刘海屏与底部手势条的 Android 真机分别测试浅色模式与深色模式，以及切换对话、工具台、设置页、侧边抽屉。
  - **操作步骤**：依次打开主聊天页、左侧项目/对话抽屉、底部弹出菜单（模型选择器/附件菜单/搜索菜单）、设置全屏页。
  - **预期结果**：顶部标题栏与图标避开状态栏和摄像头挖孔区域，底部交互按钮避开系统小白条手势区，状态栏文字颜色随主题明暗自适应切换清晰可读。
  - **常见失败回退排查**：检查异常区域是否未读取 `useSafeAreaInsets()` 或存在硬编码 `paddingTop` / `paddingBottom`。

- [ ] **R3-3. 单队列 `AppDialogHost` 并发弹窗防死锁**
  - **前置条件**：准备一次待发送的高预估费用或开启 MCP 工具的请求（会触发费用/授权确认弹窗），同时触发二次确认或异常提示。
  - **操作步骤**：
    1. 触发请求弹出确认框后，在未点击前尝试返回或触发另一提示，随后点击“取消”或使用 Android 物理返回键关闭。
    2. 立即再次发起新对话发送。
  - **预期结果**：同一时刻最多展示一个队列弹窗，无多层原生 `Modal` 互相遮挡卡死；取消后 `Promise` 立即结算并释放请求锁，可立刻发送下一条消息。
  - **常见失败回退排查**：若发送按钮持续处于禁用锁定状态，检查日志中请求租约或决策 `Promise` 是否泄漏未释放。

- [ ] **R3-4. `ProjectDrawerShell` 手势开合与中途取消无残影**
  - **前置条件**：处于主聊天界面。
  - **操作步骤**：
    1. 从屏幕左边缘向右滑动打开抽屉，反复快速开合 10 次。
    2. 滑开至 40% 位置后突然松手/反向滑回取消打开（或在打开状态下向回滑 30% 后放开）。
    3. 抽屉关闭后尝试点击聊天区顶部按钮、列表与底部输入框。
  - **预期结果**：手势跟手顺滑，中途取消能稳定回弹归位，**绝不残留半透明背景遮罩拦截触摸事件**，聊天区所有热区可正常点击。
  - **常见失败回退排查**：若偶发无法点击，检查 `ProjectDrawerShell` 手势结束是否触发 `.onFinalize` 重置遮罩 `pointerEvents` 为 `'none'`。

- [ ] **R3-5. 200+ 条长对话虚拟化吸底不抢手势 & 高频流式 Stop 即停**
  - **前置条件**：导入或构造一个包含 **200 条以上消息**的长会话（含长文本与代码块）。
  - **操作步骤**：
    1. 打开该长对话，快速向上滑动浏览历史消息。
    2. 在非底部位置保持停留同时触发新一轮较长流式输出（或观察已有输出滚动），确认页面是否强行把视角拉回底部。
    3. 点击右下角“回到底部”悬浮按钮。
    4. 流式输出高频刷新期间，点击“停止生成 (Stop)”按钮（可叠加连续 2 次点击与切换会话）。
  - **预期结果**：
    - 向上查看历史时，**列表绝不抢手势强行 `scrollToEnd`**，右下角稳定显示“回到底部”按钮；
    - 高频流式期间滚动列表帧率平稳，无主线程假死；
    - 点击“停止生成”后在 `< 200ms` 内立即中断网络流，按钮迅速恢复可输入状态，不会把已中止的工具调用误标为失败态。
  - **常见失败回退排查**：若滚动条跳动严重，检查长消息动态高度渲染缓存与 RAF 节流间隔是否异常。

### 4.2 Web 调试态 SSRF 边界与生产 `dist/` 安全/几何验收
- [ ] **R3-6. Web Dev Proxy SSRF 拦截验证 (`127.0.0.1:8787/proxy`)**
  - **前置条件**：`npm run web` 运行中（代理端口 `8787` 存活）。
  - **操作步骤**：使用终端或浏览器控制台向 `http://127.0.0.1:8787/proxy`（带 `Origin: http://localhost:8081`）发送非法目标探测：
    1. 云元数据：`https://169.254.169.254/latest/meta-data/`、`https://100.100.100.200/`、`https://[fd00:ec2::254]/`
    2. IPv4 组播/保留：`https://224.0.0.1/`、`https://240.0.0.1/`、`https://0.0.0.0/`
    3. IPv6 过渡与特殊前缀：Teredo `https://[2001:0000:4136:e378:8000:63bf:3fff:fdd2]/`、6to4 `https://[2002:a9fe:a9fe::]/`、ISATAP `https://[fe80::5efe:169.254.169.254]/`、站点本地 `https://[fec0::1]/`、组播 `https://[ff02::1]/`、IPv4 映射 `https://[::ffff:169.254.169.254]/`
    4. 非法 `Origin`（如 `Origin: https://evil.example`）。
  - **预期结果**：上述所有 SSRF 与跨域探测请求均在代理层直接返回 **`403 Forbidden`**，不发起任何真实上游 TCP 连接。
  - **常见失败回退排查**：检查 `scripts/dev-proxy.mjs` 是否在最新代码上启动，无残留旧版进程占用 `8787` 端口。

- [ ] **R3-7. Web 生产构建 `dist/` 路由映射 (`/Embezzle-Studio`) 与 Fail-Closed 拦截**
  - **前置条件**：已执行 `npm run build:web` 生成 `dist/`，并且本机 `8787` 代理已关闭。
  - **操作步骤**：
    1. 使用静态服务器托管 `dist/` 并映射到 `/Embezzle-Studio/`（可参考 `npx serve` 或仓库 `tests/e2e/helpers/staticDistServer.ts` 验证）。
    2. 在桌面视口（`1280x800`）与移动窄屏（`390x844`）分别加载页面，开启 Chrome DevTools **Network** 与 **Console** 面板。
    3. 核验顶栏模型选择按钮、导出按钮、设置按钮、输入框、发送按钮、附件/搜索菜单在两种视口下均完全可见且无相互遮挡。
    4. 配置任意测试 `API Key` 后尝试触发聊天、刷新模型或外部搜索请求，观察 Network 面板。
  - **预期结果**：
    - 首屏正常渲染，所有资源从 `/Embezzle-Studio/...` 成功加载（无 404）；
    - DevTools Console 零报错；全部可交互按钮无几何越界或覆盖层阻挡；
    - 尝试发请求时**立即在客户端被 fail-closed 拦截**，提示“正式 Web 构建不会发送 API Key 或模型请求”，**Network 面板发出 0 条外部模型/搜索请求，无任何 API Key 外泄**。
  - **常见失败回退排查**：若静态资源报 404，检查静态服务器是否正确配置了 `app.json` 中的 `"baseUrl": "/Embezzle-Studio"` 前缀路由。

---

## 五、验收签字确认

| 验收阶段 | 负责/验证人 | 验证设备 / 系统版本 | 结论（PASS / FAIL） | 备注与问题单号 |
|---|---|---|---|---|
| 一、工程基线 (`npm run check` / `dist/`) | | | | |
| 二、R1 主流模型、搜索与 Auth/Headers | | | | |
| 三、R2 生图与现代化交互 | | | | |
| 四、R3 Android 真机与 Web 安全/几何 | | | | |
