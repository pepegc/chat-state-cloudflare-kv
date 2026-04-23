import type { IWorkerKV } from "../types";

const DEFAULT_CF_API_BASE = "https://api.cloudflare.com/client/v4";

type GetValueType = "text" | "json" | "arrayBuffer" | "stream";

type KvListResponse = {
  cursor?: string;
  keys: Array<{ expiration?: number | null; name: string }>;
  list_complete?: boolean;
};

export class WorkerKvClient implements IWorkerKV {
  private readonly accountId: string;
  private readonly token: string;
  private readonly namespaceId: string;
  private readonly baseUrl: string;

  constructor(args: {
    accountId: string;
    apiToken: string;
    namespaceId: string;
    apiBaseUrl?: string;
  }) {
    this.accountId = args.accountId;
    this.token = args.apiToken;
    this.namespaceId = args.namespaceId;
    const apiBaseUrl = args.apiBaseUrl ?? DEFAULT_CF_API_BASE;
    this.baseUrl = `${apiBaseUrl}/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}`;
  }

  private async requestRaw(
    path: string,
    init: RequestInit & { method: "GET" | "PUT" | "DELETE" | "POST" },
  ): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...init.headers,
      },
    });
    return res;
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit & { method: "GET" | "PUT" | "DELETE" | "POST" },
    action: string,
  ): Promise<T> {
    const res = await this.requestRaw(path, init);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cloudflare KV ${action} failed: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  async get<T = unknown>(key: string, type: GetValueType = "text"): Promise<T | null> {
    const encodedKey = encodeURIComponent(key);
    const res = await this.requestRaw(`/values/${encodedKey}`, { method: "GET" });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cloudflare KV get failed: ${res.status} ${text}`);
    }

    if (type === "arrayBuffer") {
      return (await res.arrayBuffer()) as T;
    }
    if (type === "stream") {
      return (res.body as T | null) ?? null;
    }

    const raw = await res.text();
    if (type === "json") {
      return JSON.parse(raw) as T;
    }
    return raw as T;
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { expiration?: number; expirationTtl?: number; metadata?: unknown },
  ): Promise<void> {
    const encodedKey = encodeURIComponent(key);
    const params = new URLSearchParams();
    const { expirationTtl, expiration, metadata } = options ?? {};
    if (expirationTtl != null) params.set('expiration_ttl', String(expirationTtl));
    if (expiration != null) params.set('expiration', String(expiration));
    if (metadata != null) params.set("metadata", JSON.stringify(metadata));
    const qs = params.toString();
    const path = qs ? `/values/${encodedKey}?${qs}` : `/values/${encodedKey}`;
    const body =
      typeof value === "string" || value instanceof ArrayBuffer || value instanceof ReadableStream
        ? value
        : // Copy typed array views so body is always ArrayBuffer-backed.
          new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    const res = await this.requestRaw(path, {
      method: "PUT",
      body: body as RequestInit["body"],
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cloudflare KV put failed: ${res.status} ${text}`);
    }
  }

  async delete(key: string): Promise<void> {
    const encodedKey = encodeURIComponent(key);
    const res = await this.requestRaw(`/values/${encodedKey}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new Error(`Cloudflare KV delete failed: ${res.status} ${text}`);
    }
  }

  async list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<KvListResponse> {
    const params = new URLSearchParams();
    if (options?.prefix != null) params.set("prefix", options.prefix);
    if (options?.limit != null) params.set("limit", String(options.limit));
    if (options?.cursor != null) params.set("cursor", options.cursor);
    const qs = params.toString();
    const path = qs ? `/keys?${qs}` : "/keys";
    const data = await this.requestJson<{
      success: boolean;
      result: KvListResponse;
      errors?: Array<{ message?: string }>;
      messages?: Array<{ message?: string }>;
    }>(path, { method: "GET" }, "list");

    if (!data.success) {
      const errorMessage =
        data.errors?.map((error) => error.message).filter(Boolean).join(", ") ??
        "Unknown API error";
      throw new Error(`Cloudflare KV list failed: ${errorMessage}`);
    }

    return {
      cursor: data.result.cursor,
      keys: data.result.keys ?? [],
      list_complete: data.result.list_complete,
    };
  }
}
