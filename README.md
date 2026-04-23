# chat-state-cloudflare-kv

Cloudflare Workers KV state adapter for Chat SDK.

> Warning: This adapter is primarily for development and testing. It can be more durable than pure in-memory state because KV persists data, but KV consistency and locking semantics are still best-effort and not ideal for strict production concurrency guarantees.

## Installation

```bash
npm install chat chat-state-cloudflare-kv
```

## Usage

```ts
import { Chat } from "chat";
import { createCloudflareKVState, WorkerKvClient } from "chat-state-cloudflare-kv";

const kv = new WorkerKvClient({
  accountId: CF_ACCOUNT_ID,
  apiToken: CF_API_TOKEN,
  namespaceId: CF_KV_NAMESPACE_ID
});

const bot = new Chat({
  userName: "my-bot",
  adapters: {
    // your platform adapters here
  },
  state: createCloudflareKVState({ kv })
});
```

## Configuration

`createCloudflareKVState` accepts:

- `kv` (`KVNamespace`-compatible object, required): Cloudflare Worker KV binding
- `keyPrefix` (`string`, optional, default: `"chat-sdk"`): key namespace prefix
- `ttlMinutes` (`number`, optional, default: `360`): default TTL in minutes used for cache writes (`set` and `setIfNotExists`) when no per-call TTL is provided
- `logger` (`Logger`, optional): custom logger

## Features

| Feature | Supported |
| --- | --- |
| Persistence | Yes (Cloudflare KV-backed) |
| Multi-instance | Yes (eventual consistency) |
| Subscriptions | Yes (persistent via KV) |
| Locking | Yes (best-effort, KV semantics) |
| Queue/debounce primitives | Yes |
| List-backed message history | Yes |
| Key-value caching | Yes (`get` / `set` / `delete` / `setIfNotExists`) |

## Recommended usage

- Local development
- Integration testing
- Prototyping and low-contention workloads

## Notes on KV semantics

Cloudflare KV does not support strict atomic compare-and-set operations. This adapter preserves the Chat SDK state adapter API and uses best-effort ownership verification for locks and conditional writes.

For stricter lock guarantees under heavy concurrent write contention, use a [production state adapter](https://chat-sdk.dev/adapters).

## Development

```bash
npm run test
npm run build
```