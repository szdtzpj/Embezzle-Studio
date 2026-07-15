# Native background tasks, notifications, and Android share intake

Embezzle Studio keeps provider credentials and task state on the user's device. The native background path does not add a server, remote worker, push provider, or application-owned API quota.

## Background generation recovery

`src/services/generationTaskBackground.ts` defines one global `expo-task-manager` task. When at least one video task is active, the foreground bridge registers it with `expo-background-task` using a 15-minute minimum interval. A worker wake performs one bounded provider query per due task, writes a result to the AsyncStorage outbox, and exits. It never keeps a long polling loop alive.

The headless runtime never writes the complete workspace. When the app is foregrounded, `GenerationTaskBackgroundProvider` applies outbox entries through `WorkspaceSession` with required durability and deletes only entries that were successfully committed. This prevents a headless process from overwriting a newer foreground snapshot.

The Android system controls the actual wake time. Battery, network, Doze, OEM power management, and the user's force-stop action can delay or stop work. A task is therefore eventually recoverable, not real-time guaranteed. Foreground recovery and the existing manual task query remain important for short jobs.

## Local notifications

`expo-notifications` is used only for local completion/failure notifications. The app does not request an Expo push token, configure FCM/APNs, or require a server. Android 13+ users must grant notification permission; the `generation-tasks` channel is created before the permission prompt. Notification data contains only local task/conversation/message identifiers.

The Expo package still contributes dormant Firebase Messaging/Installations receivers and services plus `com.google.android.c2dm.permission.RECEIVE`, boot/foreground-service, and launcher-badge permissions to the generated manifest. The application does not register for a push token or configure an FCM backend, so those components are not an Embezzle-operated push path. Removing the dependency-derived manifest surface would require a smaller native local-notification module and fresh device/OEM validation; it is recorded as a hardening follow-up rather than hidden as if the generated APK lacked those entries.

Permission requests must be initiated from an explicit user action. A headless worker never opens a prompt. If permission is denied, the outbox result remains durable and the task center can show the failure and a route to system settings.

## Android system share intake

The `expo-sharing` config plugin accepts common text, image, video, PDF, and Office MIME types for `ACTION_SEND` and `ACTION_SEND_MULTIPLE`. It intentionally does not register `*/*`; Android recommends listing only types the app can actually handle.

`IncomingShareProvider` first exposes raw text/URL/file payloads for preview. The pinned `expo-sharing` patch resolves only native stream/content URIs; URL captions remain opaque authored text and do not trigger a network request. Resolved Android content URIs are copied into app-owned attachment storage before the share payload is cleared. The destination flow saves to the current conversation; text/link-only payloads may instead target project knowledge or the artifact workbench. Attachment-bearing shares keep the conversation destination so binary data is never silently dropped or coerced into a text source. The flow calls `clear()` only after that commit succeeds.

Incoming shares are capped at 32 items before any URI is opened or copied. A mixed share containing binary attachments cannot be silently converted into project knowledge or an artifact; those destinations are disabled until the user chooses a text/link-only payload. If the commit fails, the original payload and any newly copied attachments remain recoverable and the temporary files are rolled back. After a successful commit, Android's cold-start share state is cleared exactly once.

The resolved preview is authoritative while a resolution request is in flight: an AppState/raw-payload refresh cannot overwrite it with the unresolved placeholder. This keeps the user-visible preview stable across Android activity callbacks and makes a failed resolution explicit instead of losing the already-read content.

Incoming native shares and background tasks require a development or release build with a fresh prebuild. Expo Go cannot validate the generated Android intent filters or the background worker. Web intentionally degrades to the existing picker, foreground task recovery, and explicit URL/file import because `expo-sharing` does not support receiving payloads on web and `expo-background-task` is restricted there.

## Useful checks

```powershell
npx.cmd expo config --type introspect --json
npx.cmd expo-doctor
npm.cmd run typecheck
npx.cmd vitest run tests/generation-task-background.test.ts tests/generation-task-outbox.test.ts tests/incoming-share.test.ts tests/native-background-share-config.test.ts
```

On a debug native build, `BackgroundTask.triggerTaskWorkerForTestingAsync()` can invoke the worker immediately. Android's scheduled WorkManager job can be inspected with `adb shell dumpsys jobscheduler`; production timing still requires a physical-device test.

Notification taps are treated as local navigation input only. A cold-start response waits for `WorkspaceSession` boot, applies the durable task outbox, then activates the conversation and reveals the message; the OS-held response is cleared only after that route is consumed. A failed boot/recovery leaves the response available for a later retry.
