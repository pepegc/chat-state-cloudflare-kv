import { ConsoleLogger } from "chat";
import type { Lock, Logger, QueueEntry, StateAdapter } from "chat";
import type { IWorkerKV } from "./types";

export interface CloudflareKVStateOptions {
  ttlMinutes?: number;
  keyPrefix?: string;
  kv: IWorkerKV;
  logger?: Logger;
}

interface StoredLock {
  expiresAt: number;
  token: string;
}

const DEFAULT_KEY_PREFIX = "chat-sdk";
const DEFAULT_TTL_MINUTES = 6 * 60;
const MIN_QUEUE_TTL_SECONDS = 60;

export class CloudflareKVStateAdapter implements StateAdapter {
  private readonly ttlMinutes: number;
  private readonly keyPrefix: string;
  private readonly kv: IWorkerKV;
  private readonly logger: Logger;
  private connected = false;

  constructor(options: CloudflareKVStateOptions) {
    this.kv = options.kv;
    this.ttlMinutes = options.ttlMinutes ?? DEFAULT_TTL_MINUTES;
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.logger =
      options.logger ?? new ConsoleLogger("info").child("cloudflare-kv");
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async subscribe(threadId: string): Promise<void> {
    this.ensureConnected();
    await this.kv.put(this.subscriptionKey(threadId), "1");
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.ensureConnected();
    await this.kv.delete(this.subscriptionKey(threadId));
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    this.ensureConnected();
    const value = await this.kv.get<string>(this.subscriptionKey(threadId), "text");
    return value !== null;
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    this.ensureConnected();
    const key = this.lockKey(threadId);
    const now = Date.now();
    const existing = await this.kv.get<StoredLock>(key, "json");
    if (existing && existing.expiresAt > now) {
      return null;
    }

    const token = generateToken("kv");
    const expiresAt = now + ttlMs;
    await this.putJson(key, { token, expiresAt }, ttlMs);

    // KV has no atomic set-if-not-exists; verify ownership after write.
    const persisted = await this.kv.get<StoredLock>(key, "json");
    if (!persisted || persisted.token !== token) {
      return null;
    }

    return { threadId, token, expiresAt };
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.ensureConnected();
    await this.kv.delete(this.lockKey(threadId));
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.ensureConnected();
    const key = this.lockKey(lock.threadId);
    const current = await this.kv.get<StoredLock>(key, "json");
    if (!current || current.token !== lock.token) {
      return;
    }
    await this.kv.delete(key);
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    this.ensureConnected();
    const key = this.lockKey(lock.threadId);
    const current = await this.kv.get<StoredLock>(key, "json");
    if (!current || current.token !== lock.token) {
      return false;
    }
    await this.putJson(
      key,
      { token: current.token, expiresAt: Date.now() + ttlMs },
      ttlMs
    );
    return true;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.ensureConnected();
    try {
      return await this.kv.get<T>(this.cacheKey(key), "json");
    } catch (error) {
      this.logger.error("Failed to get value from KV", { error, key });
      return null;
    }
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.ensureConnected();
    await this.putJson(this.cacheKey(key), value, ttlMs ?? this.defaultCacheTtlMs());
  }

  async setIfNotExists(
    key: string,
    value: unknown,
    ttlMs?: number
  ): Promise<boolean> {
    this.ensureConnected();
    const cacheKey = this.cacheKey(key);
    const existing = await this.kv.get(cacheKey, "text");
    if (existing !== null) {
      return false;
    }
    await this.putJson(cacheKey, value, ttlMs ?? this.defaultCacheTtlMs());
    const current = await this.kv.get(cacheKey, "text");
    return current !== null;
  }

  async delete(key: string): Promise<void> {
    this.ensureConnected();
    await this.kv.delete(this.cacheKey(key));
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number }
  ): Promise<void> {
    this.ensureConnected();
    const listKey = this.listKey(key);
    const current = (await this.kv.get<unknown[]>(listKey, "json")) ?? [];
    current.push(value);

    const maxLength = options?.maxLength ?? 0;
    const next =
      maxLength > 0 && current.length > maxLength
        ? current.slice(current.length - maxLength)
        : current;

    await this.putJson(listKey, next, options?.ttlMs);
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    this.ensureConnected();
    return (await this.kv.get<T[]>(this.listKey(key), "json")) ?? [];
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    this.ensureConnected();
    const key = this.queueKey(threadId);
    const queue = (await this.kv.get<QueueEntry[]>(key, "json")) ?? [];
    queue.push(entry);

    const trimmed =
      maxSize > 0 && queue.length > maxSize
        ? queue.slice(queue.length - maxSize)
        : queue;

    const ttlMs = Math.max(entry.expiresAt - Date.now(), MIN_QUEUE_TTL_SECONDS * 1000);
    await this.putJson(key, trimmed, ttlMs);
    return trimmed.length;
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    this.ensureConnected();
    const key = this.queueKey(threadId);
    const queue = (await this.kv.get<QueueEntry[]>(key, "json")) ?? [];
    if (queue.length === 0) {
      return null;
    }

    const now = Date.now();
    let next: QueueEntry | null = null;
    const remaining: QueueEntry[] = [];

    for (const item of queue) {
      if (!next && item.expiresAt > now) {
        next = item;
        continue;
      }
      if (item.expiresAt > now) {
        remaining.push(item);
      }
    }

    if (remaining.length === 0) {
      await this.kv.delete(key);
    } else {
      const latestExpiry = remaining.reduce(
        (max, item) => Math.max(max, item.expiresAt),
        now + MIN_QUEUE_TTL_SECONDS * 1000
      );
      await this.putJson(key, remaining, Math.max(latestExpiry - now, 1000));
    }

    return next;
  }

  async queueDepth(threadId: string): Promise<number> {
    this.ensureConnected();
    const now = Date.now();
    const queue = (await this.kv.get<QueueEntry[]>(this.queueKey(threadId), "json")) ?? [];
    return queue.filter((item) => item.expiresAt > now).length;
  }

  private subscriptionKey(threadId: string): string {
    return `${this.keyPrefix}:subscriptions:${threadId}`;
  }

  private lockKey(threadId: string): string {
    return `${this.keyPrefix}:lock:${threadId}`;
  }

  private cacheKey(key: string): string {
    return `${this.keyPrefix}:cache:${key}`;
  }

  private listKey(key: string): string {
    return `${this.keyPrefix}:list:${key}`;
  }

  private queueKey(threadId: string): string {
    return `${this.keyPrefix}:queue:${threadId}`;
  }

  private defaultCacheTtlMs(): number {
    return this.ttlMinutes * 60 * 1000;
  }

  private async putJson(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlMs && ttlMs > 0) {
      const expirationTtl = Math.max(1, Math.ceil(ttlMs / 1000));
      await this.kv.put(key, serialized, { expirationTtl });
      return;
    }
    await this.kv.put(key, serialized);
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error(
        "CloudflareKVStateAdapter is not connected. Call connect() first."
      );
    }
  }
}

export function createCloudflareKVState(
  options: CloudflareKVStateOptions
): CloudflareKVStateAdapter {
  if (!options?.kv) {
    throw new Error("Cloudflare KV namespace is required.");
  }
  return new CloudflareKVStateAdapter(options);
}

function generateToken(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 15)}`;
}
