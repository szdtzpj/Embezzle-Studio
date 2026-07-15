# User-owned cloud sync

Embezzle Studio's sync is an optional client-only transport. It does not provide a server, bucket, WebDAV account, push channel, worker, quota, or telemetry backend. The storage account, permissions, retention, and bill remain the user's responsibility.

## What is synchronized

The app encrypts a bounded workspace snapshot locally and writes it with a small manifest/history. Conversations, prompts, projects, artifacts, project sources, and ordinary settings can be included. The following never enter the sync payload:

- provider API keys and MCP authorization;
- WebDAV/S3 credentials and the sync encryption password;
- media bytes and temporary provider URLs;
- the device-local `providerUsageEvents` usage-attempt ledger.

The encryption password is not recoverable by Embezzle Studio. Keep an authenticated encrypted export separately before changing devices or resolving a conflict.

## WebDAV

Use an HTTPS WebDAV endpoint, username, password, and a remote path. Create the destination collection/directory first; the client deliberately does not issue `MKCOL` or silently create a hierarchy. The endpoint must not contain embedded credentials, query tokens, or fragments. HTTP is accepted only for loopback development endpoints; HTTPS private/self-hosted destinations remain the user's explicit trust decision.

## S3-compatible storage

Use an HTTPS path-style S3 gateway, bucket, region, access key, secret key, optional session token, and an object prefix. The bucket and credentials must already exist and permit `HEAD`, `GET`, and conditional `PUT` for the prefix. Do not paste credentials into project text, diagnostics, or an artifact.

## Conflict and failure behavior

Every object is bounded to 10 MiB and the manifest to 64 KiB. The client uses ETag/`If-Match`/`If-None-Match` compare-and-swap. If a service does not prove conditional-write support, sync stops before overwriting anything. A concurrent update produces an explicit conflict; choose “keep local” or “keep remote” after the remote snapshot passes digest and decryption checks. There is no implicit last-write-wins retry.

Web stores sync credentials only in the current tab session; Android uses SecureStore. WebDAV/S3 network behavior, provider retention, and real-account billing still require acceptance against the user's own service.
