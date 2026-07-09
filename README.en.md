# Embezzle Studio

[简体中文](./README.md) | [English](./README.en.md)

Embezzle Studio is an Android-focused mobile AI chat client. The project is still in early development. Its current goal is to bring commonly used OpenAI-compatible APIs, personal relay services, and domestic model providers into one configurable mobile app, making it easier to select models, chat, and perform simple multimodal calls on mobile devices.

## Current Features

- Provider configuration: supports OpenAI-compatible APIs, Volcengine Ark, Bailian compatible mode, New API relays, and custom relay endpoints.
- Model discovery: fetches available models through provider model-list APIs, with support for search, capability tag filtering, manual addition, and removal.
- Model selection: the chat page can display added models by provider and switch the currently active model.
- Streaming chat: chat requests use streaming output by default and record token usage after the response completes.
- Reasoning settings: saves reasoning effort per model, with different parameter mappings for OpenAI, Volcengine Ark, Bailian, and related interfaces.
- Parameter tuning: temperature, top_p, repetition penalty, and similar sampling parameters can be enabled as needed; when disabled, provider defaults are used.
- Multimodal entry points: supports image attachments for chat models marked with vision capability; supports image generation model calls; supports submitting and later querying Volcengine Ark video generation tasks.
- Conversation history: saves local historical conversations, supports searching user and assistant message content, and supports pinning, renaming, sharing, and deleting conversations.
- Message actions: supports copying, regenerating, editing, and deleting individual user messages or model replies.
- Update checks: can check GitHub Releases from settings and open the update page.
- Local storage: API keys are stored with SecureStore, while regular workspace state is stored with AsyncStorage.

## Still Being Improved

- Direct video attachment uploads to generic chat APIs are not fully adapted yet; different providers need separate handling.
- MCP, the plugin system, and web-search providers have not yet been integrated as stable features.
- The official OpenAI API does not return the original hidden chain of thought; the app can only display returned reasoning summaries, `reasoning_content`, or token usage.
- Building an Android installation package requires a local Android toolchain, or a CI/EAS-based build flow.

## Tech Stack

- Expo SDK 57
- React Native 0.86
- React 19.2
- TypeScript 6
- React Native Reanimated
- React Native Gesture Handler
- AsyncStorage
- SecureStore

## Local Development

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd start
```

For Web debugging, use:

```powershell
npm.cmd run web
```

## Docs

- [Product and Architecture](./docs/product-architecture.md)
- [Roadmap](./docs/roadmap.md)
