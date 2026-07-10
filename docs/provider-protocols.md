# Provider Protocol Matrix

Last verified: 2026-07-10. This file records wire-level decisions that must stay covered by tests when model catalogs change.

## OpenAI

- Ordinary chat models use `POST /v1/chat/completions`. The request uses SSE plus `stream_options.include_usage`; the final usage event can have an empty `choices` array. [Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- `gpt-5-pro`, versioned GPT-5.x Pro models, `o1-pro`, and `o3-pro` are routed to `POST /v1/responses`. The app sends `input` and nested `reasoning.effort`; it does not send Chat-only `messages` or sampling fields. [Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- Effort values remain distinct in storage and UI: GPT-5 uses `minimal`; GPT-5.1 uses `none`; GPT-5.2+ adds `xhigh`; GPT-5.6 adds `max`; Pro model IDs use their documented subset. GPT-5.6 pro mode is a Responses `reasoning.mode`, not a separate `gpt-5.6-pro` model slug. [Reasoning guide](https://developers.openai.com/api/docs/guides/reasoning), [GPT-5](https://developers.openai.com/api/docs/models/gpt-5), [GPT-5.2](https://developers.openai.com/api/docs/models/gpt-5.2), [GPT-5.6 guidance](https://developers.openai.com/api/docs/guides/latest-model)
- Active reasoning omits sampling parameters. When sampling is supported, the client sends at most one of `temperature` and `top_p`. GPT Image omits `response_format`; DALL-E requests `b64_json` so expiring URLs are not persisted. [Latest-model parameter compatibility](https://developers.openai.com/api/docs/guides/latest-model), [Images API](https://developers.openai.com/api/reference/resources/images/methods/generate)

## Volcengine Ark

- Data-plane calls use the exact official `ark.cn-beijing.volces.com`/`ark.cn-beijing.volcengineapi.com` host with Bearer API Key. Account Endpoint discovery is a control-plane AK/HMAC operation, so the mobile app does not call it and does not assume a data-plane `/models` endpoint. Display names and lookalike hostnames never activate the Ark protocol. [Authentication and Base URL](https://www.volcengine.com/docs/82379/1298459?lang=zh), [Ark API reference](https://api.volcengine.com/api-docs/?serviceCode=ark&version=2024-01-01)
- Chat uses `/chat/completions`. Effort is model-specific: GLM 5.2 can express `none` through `max`; DeepSeek V4 preserves native `max`; DeepSeek V3.2 and GLM 4.7 expose only thinking on/off. [Chat API](https://www.volcengine.com/docs/82379/1494384?lang=zh), [Deep thinking](https://www.volcengine.com/docs/82379/1449737?lang=zh)
- Video tasks use `/contents/generations/tasks`; polling treats `queued`, `running`, `cancelled`, `succeeded`, `failed`, and `expired` distinctly. Reference images/videos are forwarded instead of silently dropped. [Create task](https://www.volcengine.com/docs/82379/1520757?lang=zh), [Query task](https://www.volcengine.com/docs/82379/1521309?lang=zh)

## Alibaba Bailian

- Compatible chat uses `/compatible-mode/v1/chat/completions`, including `reasoning_content`, final usage chunks, `image_url`, and provider-specific `video_url`. [OpenAI-compatible Chat](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- Thinking-only models (QwQ, QVQ, DeepSeek R1, and thinking-only Qwen variants) never receive `enable_thinking:false`. Mixed models may expose on/off. Numeric `thinking_budget` is sent only to model families that document it. [Deep thinking models](https://help.aliyun.com/zh/model-studio/deep-thinking/), [Visual reasoning](https://help.aliyun.com/zh/model-studio/visual-reasoning)
- GLM 5/5.1 preserve `xhigh` and never send `max`; GLM 5.2 may send `max`. DeepSeek V4 uses its native `high|max` subset. [GLM models](https://help.aliyun.com/zh/model-studio/glm), [DeepSeek models](https://help.aliyun.com/zh/model-studio/deepseek-api)
- Bailian `/models` is treated as an optional compatibility feature. A missing or malformed response directs the user to the official model catalog and manual Model ID entry instead of making the provider unusable. [Model catalog](https://help.aliyun.com/zh/model-studio/models)

## Regression tests

The table is exercised by `tests/reasoning-efforts.test.ts`, `tests/openai-responses.test.ts`, `tests/openai-routing-integration.test.ts`, `tests/bailian-compatible.test.ts`, and `tests/ark-model-discovery.test.ts`.
