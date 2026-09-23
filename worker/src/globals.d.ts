/**
 * Ambient global type declarations replacing @cloudflare/workers-types.
 *
 * This project now runs on EdgeOne Makers (Node.js). A few legacy code paths
 * still reference Worker-flavored globals without importing them, so they are
 * declared here — with D1Database aliased to the Blob-backed engine, which
 * also removes the need to structurally match Cloudflare's D1 meta types.
 */
import type { BlobDatabase } from "./db/blob-database";

declare global {
  /** D1Database is aliased to the Blob-backed engine (see types.ts). */
  type D1Database = BlobDatabase;

  interface Fetcher {
    fetch(request: Request): Response | Promise<Response>;
  }

  interface Ai {
    run(model: unknown, input: unknown, options?: unknown): Promise<unknown>;
  }

  interface KVNamespace {
    get<T = any>(
      key: string,
      type?: "text" | "json" | "arrayBuffer" | "stream"
    ): Promise<T | null>;
    put(
      key: string,
      value: string | ReadableStream | ArrayBuffer,
      options?: KVNamespacePutOptions
    ): Promise<void>;
    delete(key: string): Promise<void>;
  }

  interface KVNamespacePutOptions {
    expirationTtl?: number;
    expiration?: number;
    metadata?: unknown;
  }
}

export {};
