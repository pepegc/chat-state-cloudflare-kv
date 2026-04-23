export interface IWorkerKV {
  delete(key: string): Promise<void>;
  get<T = unknown>(
    key: string,
    type?: "text" | "json" | "arrayBuffer" | "stream"
  ): Promise<T | null>;
  list(options?: { cursor?: string; limit?: number; prefix?: string }): Promise<{
    cursor?: string;
    keys: Array<{ expiration?: number | null; name: string }>;
    list_complete?: boolean;
  }>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { expiration?: number; expirationTtl?: number; metadata?: unknown }
  ): Promise<void>;
}
