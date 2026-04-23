import { describe, expect, it } from "vitest";
import { CloudflareKVStateAdapter, createCloudflareKVState } from "./index";

class InMemoryKV {
  private store = new Map<string, { expiresAt?: number; value: string }>();

  async get<T = unknown>(
    key: string,
    type?: "text" | "json" | "arrayBuffer" | "stream"
  ): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }

    if (type === "text") {
      return entry.value as T;
    }
    if (type === "json") {
      return JSON.parse(entry.value) as T;
    }
    throw new Error("Unsupported test get() type");
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { expiration?: number; expirationTtl?: number; metadata?: unknown }
  ): Promise<void> {
    if (typeof value !== "string") {
      throw new Error("Test KV only supports string values");
    }
    const expiresAt = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : options?.expiration
        ? options.expiration * 1000
        : undefined;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: {
    cursor?: string;
    limit?: number;
    prefix?: string;
  }): Promise<{
    cursor?: string;
    keys: Array<{ expiration?: number | null; name: string }>;
    list_complete?: boolean;
  }> {
    const prefix = options?.prefix ?? "";
    const keys = Array.from(this.store.keys())
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }

  getEntry(key: string): { expiresAt?: number; value: string } | undefined {
    return this.store.get(key);
  }
}

describe("CloudflareKVStateAdapter", () => {
  it("handles subscriptions", async () => {
    const kv = new InMemoryKV();
    const state = new CloudflareKVStateAdapter({ kv });
    await state.connect();

    await state.subscribe("thread:1");
    expect(await state.isSubscribed("thread:1")).toBe(true);

    await state.unsubscribe("thread:1");
    expect(await state.isSubscribed("thread:1")).toBe(false);
  });

  it("handles locks", async () => {
    const kv = new InMemoryKV();
    const state = new CloudflareKVStateAdapter({ kv });
    await state.connect();

    const first = await state.acquireLock("thread:1", 30_000);
    expect(first).not.toBeNull();

    const second = await state.acquireLock("thread:1", 30_000);
    expect(second).toBeNull();

    const extended = await state.extendLock(first!, 30_000);
    expect(extended).toBe(true);

    await state.releaseLock(first!);
    const third = await state.acquireLock("thread:1", 30_000);
    expect(third).not.toBeNull();
  });

  it("handles cache and setIfNotExists", async () => {
    const kv = new InMemoryKV();
    const state = new CloudflareKVStateAdapter({ kv });
    await state.connect();

    await state.set("foo", { ok: true });
    expect(await state.get<{ ok: boolean }>("foo")).toEqual({ ok: true });

    expect(await state.setIfNotExists("foo", "nope")).toBe(false);
    expect(await state.setIfNotExists("bar", "yes")).toBe(true);
    expect(await state.get<string>("bar")).toBe("yes");
  });

  it("uses default ttlMinutes and allows overriding it", async () => {
    const kv = new InMemoryKV();
    const state = new CloudflareKVStateAdapter({ kv });
    await state.connect();

    const beforeDefaultSet = Date.now();
    await state.set("default-ttl", "value");
    const defaultExpiresAt = kv.getEntry("chat-sdk:cache:default-ttl")?.expiresAt;
    expect(defaultExpiresAt).toBeDefined();
    // Allow a small tolerance for test execution time and second rounding.
    expect(defaultExpiresAt!).toBeGreaterThanOrEqual(beforeDefaultSet + 6 * 60 * 60 * 1000);
    expect(defaultExpiresAt!).toBeLessThan(beforeDefaultSet + 6 * 60 * 60 * 1000 + 2_000);

    const beforeOverrideSet = Date.now();
    await state.set("override-ttl", "value", 1_000);
    const overrideExpiresAt = kv.getEntry("chat-sdk:cache:override-ttl")?.expiresAt;
    expect(overrideExpiresAt).toBeDefined();
    expect(overrideExpiresAt!).toBeGreaterThanOrEqual(beforeOverrideSet + 1_000);
    expect(overrideExpiresAt!).toBeLessThan(beforeOverrideSet + 3_000);
  });

  it("supports configuring default cache TTL in minutes", async () => {
    const kv = new InMemoryKV();
    const state = new CloudflareKVStateAdapter({ kv, ttlMinutes: 2 });
    await state.connect();

    const beforeSet = Date.now();
    await state.set("custom-minutes", "value");
    const expiresAt = kv.getEntry("chat-sdk:cache:custom-minutes")?.expiresAt;
    expect(expiresAt).toBeDefined();
    expect(expiresAt!).toBeGreaterThanOrEqual(beforeSet + 2 * 60 * 1000);
    expect(expiresAt!).toBeLessThan(beforeSet + 2 * 60 * 1000 + 2_000);
  });

  it("handles list operations", async () => {
    const kv = new InMemoryKV();
    const state = new CloudflareKVStateAdapter({ kv });
    await state.connect();

    await state.appendToList("history", "a");
    await state.appendToList("history", "b");
    await state.appendToList("history", "c", { maxLength: 2 });

    expect(await state.getList<string>("history")).toEqual(["b", "c"]);
  });

  it("handles queue operations", async () => {
    const kv = new InMemoryKV();
    const state = createCloudflareKVState({ kv });
    await state.connect();

    const now = Date.now();
    await state.enqueue(
      "thread:1",
      { enqueuedAt: now, expiresAt: now + 30_000, message: { id: "1" } as never },
      10
    );
    await state.enqueue(
      "thread:1",
      { enqueuedAt: now + 1, expiresAt: now + 30_000, message: { id: "2" } as never },
      10
    );

    expect(await state.queueDepth("thread:1")).toBe(2);
    expect((await state.dequeue("thread:1"))?.message).toEqual({ id: "1" });
    expect(await state.queueDepth("thread:1")).toBe(1);
    expect((await state.dequeue("thread:1"))?.message).toEqual({ id: "2" });
    expect(await state.dequeue("thread:1")).toBeNull();
  });

  it("throws when used before connect", async () => {
    const kv = new InMemoryKV();
    const state = new CloudflareKVStateAdapter({ kv });
    await expect(state.get("x")).rejects.toThrow("connect");
  });
});
