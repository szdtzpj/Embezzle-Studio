# Embezzle Studio

Embezzle Studio is an Android-first mobile AI workspace for personal multi-provider model usage. The app is being built as a Cherry Studio-style mobile client with stronger mobile ergonomics: provider configuration, model discovery, multimodal chat, plugin entry points, and remote MCP support.

## Current Stack

- Expo SDK 57
- React Native 0.86
- React 19.2
- TypeScript 6
- SecureStore for provider secrets
- AsyncStorage for non-secret workspace state

## First Milestone

- Configure OpenAI-compatible providers such as Volcengine Ark, Alibaba Bailian compatible mode, New API relays, and custom relays.
- Fetch models from a configured provider through `GET /models`.
- Chat through `POST /chat/completions`.
- Attach images to capable models through Chat Completions image data URLs.
- Keep video attachments in the conversation model, with provider-specific upload adapters planned for Doubao/video-capable models.
- Keep MCP scoped to remote transports first; mobile stdio MCP is intentionally out of scope for the first Android build.

## Development

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd start
```

On this machine there is no Java, Gradle, or Android SDK installed yet, so local APK creation is not available here. The generated Expo project can still be developed locally and later built with an Android toolchain or EAS Build.

## Docs

- [Product and Architecture](./docs/product-architecture.md)
- [Roadmap](./docs/roadmap.md)
