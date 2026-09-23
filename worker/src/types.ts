/**
 * EdgeOne Environment Types
 * Uses Blob storage for all data (no external database)
 */

import { BlobDatabase } from "./db/blob-database";
import { StorageProvider } from "./storage";

export interface Env {
  // Blob Storage (edgeOne Blob) - default
  BLOB_STORE_NAME?: string;
  
  // Optional S3-compatible storage
  STORAGE_TYPE?: 'blob' | 's3';
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_FORCE_PATH_STYLE?: string;
  
  // KV Cache (optional - can use EdgeOne KV)
  CACHE?: KVNamespace;
  
  // AI (can use external API)
  AI?: Ai;
  
  // Secrets
  JWT_SECRET: string;
  
  // Config
  INSTANCE_NAME: string;
  APP_VERSION: string;
  
  // Database & object storage — attached lazily by initProviders middleware
  // before any route runs (see middleware/providers.ts), so from a route's
  // perspective they are always present.
  DB: BlobDatabase;
  BUCKET: StorageProvider;
}

export interface UserPayload {
  id: number;
  username: string;
  role: string;
  status: string;
}

export interface JWTClaims {
  sub: string;
  iss: string;
  aud: string;
  name: string;
  role: string;
  status: string;
  exp: number;
  iat: number;
  tid?: string;
}

// D1Database compatibility interface
export type D1Database = BlobDatabase;

// R2Bucket compatibility interface (use StorageProvider)
export type R2Bucket = StorageProvider;

// KVNamespace compatibility interface
export interface KVNamespace {
  get<T = any>(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<T | null>;
  put(key: string, value: string | ReadableStream | ArrayBuffer, options?: KVNamespacePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: KVNamespaceListOptions): Promise<KVNamespaceListResult>;
}

export interface KVNamespacePutOptions {
  expirationTtl?: number;
  expiration?: number;
  metadata?: Record<string, unknown>;
}

export interface KVNamespaceListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface KVNamespaceListResult {
  keys: Array<{ name: string; expiration?: number }>;
  list_complete: boolean;
  cursor?: string;
}

// Ai binding (optional)
export interface Ai {
  run(model: string, inputs: Record<string, any>): Promise<any>;
}

// Fetcher for ASSETS
export interface Fetcher {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
}