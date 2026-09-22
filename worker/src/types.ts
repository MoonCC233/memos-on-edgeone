/**
 * EdgeOne Environment Types
 * Replaces Cloudflare-specific bindings with EdgeOne equivalents
 */

export interface Env {
  // Static assets (EdgeOne Pages)
  ASSETS: Fetcher;
  
  // Database (Turso/libSQL)
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN?: string;
  
  // Blob Storage (EdgeOne Blob) - default
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
  
  // AI (can use Cloudflare AI remotely or other providers)
  AI?: Ai;
  
  // Secrets
  JWT_SECRET: string;
  
  // Config
  INSTANCE_NAME: string;
  APP_VERSION: string;
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

// Type for EdgeOne Pages Functions context
export interface EdgeOneContext {
  env: Env;
  request: Request;
  params: Record<string, string>;
  waitUntil: (promise: Promise<any>) => void;
  next: () => Promise<Response>;
}

// D1Database compatibility interface (for gradual migration)
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
  raw<T = unknown>(): Promise<T[]>;
}

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  error?: string;
  meta: {
    duration: number;
    rows_read: number;
    rows_written: number;
  };
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

// R2Bucket compatibility interface (for gradual migration)
export interface R2Bucket {
  put(key: string, value: ReadableStream | ArrayBuffer | string, options?: R2PutOptions): Promise<R2Object | null>;
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<boolean>;
  list(options?: R2ListOptions): Promise<R2ListResult>;
  createMultipartUpload(key: string, options?: R2MultipartOptions): Promise<R2MultipartUpload>;
}

export interface R2PutOptions {
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

export interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentEncoding?: string;
  contentDisposition?: string;
  cacheControl?: string;
}

export interface R2GetOptions {
  range?: R2Range;
}

export interface R2Range {
  offset: number;
  length?: number;
  suffix?: number;
}

export interface R2Object {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
  uploaded: Date;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
  blob(): Promise<Blob>;
}

export interface R2ListOptions {
  prefix?: string;
  delimiter?: string;
  cursor?: string;
  limit?: number;
}

export interface R2ListResult {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: string[];
}

export interface R2MultipartOptions {
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

export interface R2MultipartUpload {
  key: string;
  uploadId: string;
  uploadPart(partNumber: number, value: ReadableStream | ArrayBuffer | string): Promise<R2UploadedPart>;
  abort(): Promise<void>;
  complete(parts: R2UploadedPart[]): Promise<R2Object>;
}

export interface R2UploadedPart {
  partNumber: number;
  etag: string;
}

// KVNamespace compatibility interface
export interface KVNamespace {
  get(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<any>;
  put(key: string, value: string | ReadableStream | ArrayBuffer, options?: KVNamespacePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: KVNamespaceListOptions): Promise<KVNamespaceListResult>;
  getWithMetadata(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<KVNamespaceGetWithMetadataResult>;
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
  keys: KVNamespaceListKey[];
  list_complete: boolean;
  cursor?: string;
}

export interface KVNamespaceListKey {
  name: string;
  expiration?: number;
  metadata?: Record<string, unknown>;
}

export interface KVNamespaceGetWithMetadataResult<T = unknown> {
  value: T | null;
  metadata: Record<string, unknown> | null;
}

// Ai binding (Workers AI compatible)
export interface Ai {
  run(model: string, inputs: Record<string, any>): Promise<any>;
}

// Fetcher for ASSETS
export interface Fetcher {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
}