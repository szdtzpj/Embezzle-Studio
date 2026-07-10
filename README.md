# Embezzle Studio

[简体中文](./README.md) | [English](./README.en.md)

Embezzle Studio 是一个面向 Android 的移动端 AI 对话客户端。项目还在早期开发中，当前目标是把常用的 OpenAI 兼容接口、个人中转站和国内模型服务商集中到一个可配置的手机应用里，方便在移动端进行模型选择、对话和简单的多模态调用。

## 当前功能

- 服务商配置：支持 OpenAI 兼容接口、火山方舟、百炼兼容模式、New API 中转站和自定义中转地址。
- 模型获取：OpenAI/兼容服务商尝试模型列表接口；火山方舟只在精确官方数据面主机上尝试未列入官方 API 参考的兼容 `/models` 探测，失败或响应不兼容时回退到根据官方目录维护的本地精选候选，并始终支持手动添加 Model ID 或 Endpoint ID。
- 模型选择：聊天页可按服务商查看已添加模型，并切换当前激活模型。
- 对话协议：Chat Completions 默认流式输出；OpenAI Responses-only Pro 模型自动切换 `/responses` 非流式协议，并记录 Token 用量。
- 思考设置：按精确模型系列保存思考强度，区分 `off`、`none`、`minimal`、`xhigh`、`max`，并分别映射 OpenAI、火山方舟和百炼协议。
- 参数调整：按服务商和模型只显示已适配的温度、top_p、惩罚参数及其真实范围；思考模式或固定参数模型会明确提示或隐藏无效控件，关闭后交给服务商默认值处理。
- 多模态入口：按模型能力显示图片、视频和文件选择入口；图片可发送给视觉模型，百炼兼容模式支持有界的本地视频 `video_url` 输入，文件输入仅对显式具备 `file-input` 能力的 OpenAI 官方模型开放。另支持文本生图，以及带参考图片/视频的火山方舟视频任务提交和后续查询。
- 对话记录：本地保存历史会话，支持搜索用户和模型回复内容，并支持置顶、改名、分享、删除。
- 消息操作：支持原生/网页复制、分享、停止生成、保留流式部分内容、重新生成、编辑和按因果分支删除。
- 更新检查：从固定的公共 Pages 更新清单检查版本和已校验 APK 元数据，并跳转到受信任的发布页面；应用本身不会伪装成 APK 校验器或安装器。
- 本地存储：Android API Key 使用 SecureStore；Web API Key 只保留在当前标签页的 `sessionStorage`/内存中，并会迁移清除旧版持久化值。工作区使用带版本和备份的 AsyncStorage；原生附件复制到应用文件目录，Web 附件以 Blob 存入 IndexedDB，避免把大型 Base64 写进工作区 JSON。

## 仍在完善

- 对话视频附件目前只为百炼兼容模式实现 `video_url` 传输；其他服务商仍需各自的上传、转码或引用协议适配。
- MCP、插件系统和联网搜索服务商还没有作为稳定功能接入。
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

首个正式签名版本 [`v1.0.4`](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.0.4) 已于 2026-07-10 发布为 immutable Latest Release。公开的[可信下载页](https://szdtzpj.github.io/Embezzle-Studio/release.html)提供 93,087,208 字节 APK；SHA-256 为 `187f4a90daed7c7d05d423890419d1c4fe1d705674bf1d4955075c8d725b63f0`，正式证书 SHA-256 为 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`。GitHub release attestation、三个本地下载资产和 Pages 匿名 APK 字节均已独立复核。

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
3. 暂停其它 `main` 合并和新版本 Release；从最新 `origin/main` 的精确提交创建并推送与应用版本一致的 tag，例如下一版本 `v1.0.5`。
4. 确认仓库已启用 Immutable Releases，由 `szdtzpj` 创建同名、非 prerelease 的空 draft Release，再从默认分支 `main` 手动运行 Android 工作流；不要提前发布空 Release。
5. 工作流会检出与当前 `origin/main` 完全相同的 tag 提交，生成未签名 APK，使用正式 keystore 签名，并在冻结前后重复核对 tag/main 提交以及每个 GitHub asset 的 digest、状态与 uploader，然后才把 draft 发布为 latest immutable Release。等该工作流、自动触发的 Pages 工作流、Release attestation 和公开 APK 字节校验都成功后，才结束发布冻结。

示例：

```powershell
git fetch origin
$mergeSha = git rev-parse origin/main
git tag -a v1.0.5 $mergeSha -m "Embezzle Studio v1.0.5"
git push origin v1.0.5
gh api --method PUT repos/szdtzpj/Embezzle-Studio/immutable-releases
gh release create v1.0.5 --repo szdtzpj/Embezzle-Studio --verify-tag --draft --title "Embezzle Studio v1.0.5" --notes "Android production release v1.0.5."
gh workflow run android-apk.yml --repo szdtzpj/Embezzle-Studio --ref main -f release_tag=v1.0.5
```

Release 标题、正文与发布时间会被复制到公开 Pages 清单和下载页。创建 draft 前必须把这些文字当作公开内容审阅，不得包含私有仓库、账号、客户或密钥信息；不要未经检查直接使用自动生成的 release notes。

`v1.0.3` 及更早版本和 `v1.0.4-debug.*` 预发布使用生成的 debug 签名，只能作为测试安装包，不能作为正式发布签名的信任起点。迁移到正式 `v1.0.4` 或后续版本前应先导出重要数据，再卸载测试包（会清除应用本地数据）并安装正式 APK；Android 不允许用新的正式证书直接覆盖这些 debug-signed 安装。

应用内更新检查不会携带 GitHub Token。私有仓库的 Releases API 和下载页对普通安装用户会返回 `404`，因此签名发布成功后，Pages 工作流会自动重新运行，并通过 `scripts/stage-release-for-pages.mjs` 处理最新稳定 Release。脚本只接受由仓库所有者发布的 GitHub Immutable Release，以及由 `github-actions[bot]` 上传、状态为 uploaded、带 GitHub SHA-256 digest 的精确 APK/校验文件；随后仍会自行下载字节、复算两个 asset digest，并把校验条目精确绑定到 `Embezzle-Studio-${tag}-release.apk`。全部一致后才暂存公共 APK、生成 `release.html`，并让清单 `releaseUrl` 指向该页。

缺少预期 APK/校验文件，或 Release/asset 的来源 URL、状态、uploader、digest 元数据不满足信任条件时，脚本只生成 `apk: null` 的 fail-closed 清单并撤下旧的受管下载输出；实际下载字节与 GitHub digest/校验文件不一致，或 APK 超过 256 MiB、校验文件超过 64 KiB 时才会使 Pages 构建失败。响应声明大小和实际流式读取字节都会受限。下载页也明确说明：Immutable Release、GitHub asset digest 与校验文件仍不替代工作流中的 `apksigner` 正式证书校验。客户端固定读取公共清单，只接受本仓库精确 GitHub Release 路径或 `https://szdtzpj.github.io/Embezzle-Studio/` 下受限路径；只有同时得到可信安装资产且版本更高时才提示可更新，并在设置页展示摘要后打开可信发布页，不会直接安装 APK。不要把 GitHub PAT 内置到客户端。

GitHub Release 的多个资产上传不是事务操作。工作流仅在 owner-authored 空 draft 上上传；失败时会尝试删除由 `github-actions[bot]` 写入的预期部分资产，其他 uploader 或无法自动清理的状态仍需维护者人工核对。draft 的三个资产全部核验后才发布，发布后还会对 immutable 快照的 refs、精确资产集合、digest、状态与 uploader 做一次后验复核。GitHub 随后锁定 Release 的 tag/资产并生成 attestation；不要为了自动重试而允许覆盖已发布资产。

## 文档

- [Product and Architecture](./docs/product-architecture.md)
- [Provider Protocol Matrix](./docs/provider-protocols.md)
- [Roadmap](./docs/roadmap.md)
