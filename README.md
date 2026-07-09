# Embezzle Studio

Embezzle Studio 是一个面向 Android 的移动端 AI 对话客户端。项目还在早期开发中，当前目标是把常用的 OpenAI 兼容接口、个人中转站和国内模型服务商集中到一个可配置的手机应用里，方便在移动端进行模型选择、对话和简单的多模态调用。

## 当前功能

- 服务商配置：支持 OpenAI 兼容接口、火山方舟、百炼兼容模式、New API 中转站和自定义中转地址。
- 模型获取：通过服务商的模型列表接口获取可用模型，并支持搜索、能力标签筛选、手动添加和移除。
- 模型选择：聊天页可按服务商查看已添加模型，并切换当前激活模型。
- 流式对话：聊天请求默认使用流式输出，并在响应结束后记录 Token 用量。
- 思考设置：按模型保存思考强度，针对 OpenAI、火山方舟、百炼等接口做了不同参数映射。
- 参数调整：可按需启用温度、top_p、重复惩罚等采样参数；关闭后交给服务商默认值处理。
- 多模态入口：支持图片附件上传到已标记为视觉能力的对话模型；支持图片生成模型调用；火山方舟视频生成任务支持提交和后续查询。
- 对话记录：本地保存历史会话，支持搜索用户和模型回复内容，并支持置顶、改名、分享、删除。
- 消息操作：支持复制、重新生成、编辑和删除单条用户消息或模型回复。
- 更新检查：可在设置中检查 GitHub Release，并跳转到更新页面。
- 本地存储：API Key 使用 SecureStore 保存，普通工作区状态使用 AsyncStorage 保存。

## 仍在完善

- 视频附件直接上传到通用对话接口还没有完整适配，不同服务商需要分别处理。
- MCP、插件系统和联网搜索服务商还没有作为稳定功能接入。
- OpenAI 官方接口不会返回原始隐藏思考链；应用只能展示接口返回的思考摘要、reasoning_content 或 Token 用量。
- Android 安装包构建需要本机 Android 工具链，或通过 CI/EAS 等方式构建。

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
npm.cmd install
npm.cmd run typecheck
npm.cmd start
```

Web 调试可以使用：

```powershell
npm.cmd run web
```

## 文档

- [Product and Architecture](./docs/product-architecture.md)
- [Roadmap](./docs/roadmap.md)
