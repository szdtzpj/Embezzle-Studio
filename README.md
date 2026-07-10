# Embezzle Studio

[简体中文](./README.md) | [English](./README.en.md)

Embezzle Studio 是一个面向 Android 的移动端 AI 对话客户端。项目还在早期开发中，当前目标是把常用的 OpenAI 兼容接口、个人中转站和国内模型服务商集中到一个可配置的手机应用里，方便在移动端进行模型选择、对话和简单的多模态调用。

## 当前功能

- 服务商配置：支持 OpenAI 兼容接口、火山方舟、百炼兼容模式、New API 中转站和自定义中转地址。
- 模型获取：OpenAI/兼容服务商尝试模型列表接口；火山方舟使用官方版本化模型目录候选，并支持手动添加 Model ID 或 Endpoint ID。
- 模型选择：聊天页可按服务商查看已添加模型，并切换当前激活模型。
- 对话协议：Chat Completions 默认流式输出；OpenAI Responses-only Pro 模型自动切换 `/responses` 非流式协议，并记录 Token 用量。
- 思考设置：按精确模型系列保存思考强度，区分 `off`、`none`、`minimal`、`xhigh`、`max`，并分别映射 OpenAI、火山方舟和百炼协议。
- 参数调整：可按需启用温度、top_p、重复惩罚等采样参数；关闭后交给服务商默认值处理。
- 多模态入口：按模型能力显示图片、视频和文件选择入口；图片可发送给视觉模型，百炼兼容模式支持有界的本地视频 `video_url` 输入，文件输入仅对显式具备 `file-input` 能力的 OpenAI 官方模型开放。另支持文本生图，以及带参考图的火山方舟视频任务提交和后续查询。
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

`.github/workflows/android-apk.yml` 只允许使用稳定的正式密钥签名。签名前会用最新 Android build-tools 的 `aapt` 核对实际 APK 的包名、版本、min/target SDK，并拒绝 CAMERA、RECORD_AUDIO、SYSTEM_ALERT_WINDOW 权限；它也不会再把 Gradle 自动生成的 debug keystore 当作 release 签名。缺少任一签名 Secret、产物契约不符、证书指纹不一致或检测到 `Android Debug` 证书时，工作流会直接失败。

先在 GitHub 仓库的 `Settings -> Environments -> android-release` 中创建发布环境，把 deployment branch policy 限制为 `main`，并配置以下 Environment secrets。若仓库/组织方案支持 deployment protection rules，还应启用 required reviewers 和 `Prevent self-review`。[GitHub Environments 官方限制](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)说明：Free、Pro 或 Team 方案的 required reviewers 只可用于公开仓库；私有仓库的 Environment secrets 和 deployment branches/tags 至少需要 Pro/Team，保持私有并获得 required reviewers 则需要 Enterprise。因而本仓库若保持个人私有且使用 Pro/Team，只能采用“仅允许 `main` + 无人工审批”的降级保护；若是 Free，则连这组私有环境 Secret/分支限制也不可用。把正式密钥写入该环境前，必须确认实际方案能力，并确认所有具有仓库写权限的协作者都被信任或先收紧其权限；不要把降级配置描述成等价的双人审批。

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
3. 暂停其它 `main` 合并和新版本 Release；从最新 `origin/main` 的精确提交创建并推送与应用版本一致的 tag，例如 `v1.0.4`。
4. 先创建同名、非 draft、非 prerelease 的 GitHub Release，再从默认分支 `main` 手动运行 Android 工作流。
5. 工作流会检出 tag 对应的提交，生成未签名 APK，使用正式 keystore 执行 `zipalign` 和 `apksigner`，验证证书指纹，生成 `.sha256`，最后把 APK 和校验文件附加到 Release。等该工作流和随后自动触发的 Pages 工作流都成功并完成公开字节校验后，才结束发布冻结。

示例：

```powershell
git fetch origin
$mergeSha = git rev-parse origin/main
git tag -a v1.0.4 $mergeSha -m "Embezzle Studio v1.0.4"
git push origin v1.0.4
gh release create v1.0.4 --repo szdtzpj/Embezzle-Studio --verify-tag --title "Embezzle Studio v1.0.4" --generate-notes
gh workflow run android-apk.yml --repo szdtzpj/Embezzle-Studio --ref main -f release_tag=v1.0.4
```

`v1.0.3` 及更早的现有 APK 使用生成的 debug 签名，只能作为测试安装包，不能作为正式发布签名的信任起点。Android 不允许用新的正式证书直接覆盖安装这些 debug-signed APK；迁移时需要卸载测试包（会清除应用本地数据），或在正式发布前另行设计数据迁移方案。

应用内更新检查不会携带 GitHub Token。私有仓库的 Releases API 和下载页对普通安装用户会返回 `404`，因此签名发布成功后，Pages 工作流会自动重新运行，并通过 `scripts/stage-release-for-pages.mjs` 处理最新稳定 Release：脚本只选择名称精确为 `Embezzle-Studio-${tag}-release.apk` 的产物，并要求同名 `.apk.sha256` 或 `SHA256SUMS` 中与该 APK 文件名精确绑定的条目。只有 APK 实际字节与此摘要完全匹配后，脚本才会把 APK 暂存到公共 Pages 产物、生成 `release.html` 可信下载页，并让 `release-manifest.json` 的 `releaseUrl` 指向该页。下载页显示版本、文件大小、完整 SHA-256 和经过 HTML 转义的发布说明；APK 名称会作为单一路径段进行 URL 编码。

缺少预期 APK/校验文件时，脚本只生成 `apk: null` 的 fail-closed 清单，不生成下载页；摘要不匹配、来源 URL 不可信，或 APK 超过 256 MiB/校验文件超过 64 KiB 时会使 Pages 构建失败，响应声明大小和实际流式读取字节都会受限。下载页也明确说明：SHA-256 一致只证明公开字节与 Release 校验文件一致，并不替代工作流中的 `apksigner` 正式证书校验。客户端固定读取公共清单，只接受本仓库精确 GitHub Release 路径或 `https://szdtzpj.github.io/Embezzle-Studio/` 下受限路径，并在设置页展示摘要后打开可信发布页，不会直接安装 APK。不要把 GitHub PAT 内置到客户端。

GitHub Release 的多个资产上传不是事务操作。若 APK、`.sha256`、`apksigner-report.txt` 只上传了一部分，工作流会拒绝覆盖并停止；维护者必须先在 Release 页面核对已存在资产，删除确认属于本次失败运行的不完整资产，再重新运行工作流。不要为了自动重试而启用覆盖发布资产。

## 文档

- [Product and Architecture](./docs/product-architecture.md)
- [Provider Protocol Matrix](./docs/provider-protocols.md)
- [Roadmap](./docs/roadmap.md)
