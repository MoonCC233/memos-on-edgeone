/**
 * Storage Abstraction Layer
 * Supports EdgeOne Blob (default) and S3-compatible storage
 */

export interface StorageConfig {
  type: 'blob' | 's3';
  // EdgeOne Blob config
  blobStoreName?: string;
  // S3 config
  s3Endpoint?: string;
  s3Region?: string;
  s3Bucket?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3ForcePathStyle?: boolean;
}

export interface StorageObject {
  key: string;
  body: ReadableStream | ArrayBuffer | string;
  contentType?: string;
  contentLength?: number;
  metadata?: Record<string, string>;
}

export interface GetObjectResult {
  body: ReadableStream | null;
  contentType?: string;
  contentLength?: number;
  metadata?: Record<string, string>;
}

export interface ListObjectsResult {
  objects: Array<{
    key: string;
    size: number;
    lastModified: Date;
    contentType?: string;
  }>;
  prefixes: string[];
  nextToken?: string;
}

export interface UploadUrlResult {
  url: string;
  key: string;
  expiresAt: number;
}

export interface StorageProvider {
  put(key: string, body: ArrayBuffer | ReadableStream | string, options?: { contentType?: string; metadata?: Record<string, string> }): Promise<void>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<GetObjectResult | null>;
  delete(key: string): Promise<void>;
  list(prefix: string, options?: { delimiter?: string; maxKeys?: number; token?: string }): Promise<ListObjectsResult>;
  createUploadUrl(key: string, options?: { expireSeconds?: number; contentType?: string }): Promise<UploadUrlResult>;
  exists(key: string): Promise<boolean>;
}

// EdgeOne Blob Provider
//
// Notes on the @edgeone/pages-blob SDK (v0.0.16):
//  - get() returns the typed value directly (string / ArrayBuffer /
//    ReadableStream / ...), NOT a { body } wrapper.
//  - set() accepts no contentType/metadata options; attachment content types
//    are served from DB records (AttachmentRow.type) instead.
//  - Reads default to "eventual" (CDN-cached) consistency; we force "strong"
//    on every read so read-after-write holds for the JSON table blobs.
export class EdgeOneBlobProvider implements StorageProvider {
  private store: any;

  constructor(private storeName: string) {}

  private async getStore() {
    if (!this.store) {
      const { getStore } = await import('@edgeone/pages-blob');
      this.store = getStore(this.storeName);
    }
    return this.store;
  }

  async put(
    key: string,
    body: ArrayBuffer | ReadableStream | string,
    _options?: { contentType?: string; metadata?: Record<string, string> }
  ): Promise<void> {
    const store = await this.getStore();
    await store.set(key, body);
  }

  async get(
    key: string,
    options?: { range?: { offset: number; length: number } }
  ): Promise<GetObjectResult | null> {
    const store = await this.getStore();
    const useRange = !!options?.range;
    const value = useRange
      ? await store.get(key, { type: 'arrayBuffer', consistency: 'strong' })
      : await store.get(key, { type: 'stream', consistency: 'strong' });

    if (value === null || value === undefined) return null;

    if (value instanceof ArrayBuffer) {
      let buf = value;
      if (options?.range) {
        const { offset, length } = options.range;
        const start = Math.min(Math.max(offset, 0), buf.byteLength);
        buf = buf.slice(start, start + Math.max(length, 0));
      }
      const chunk = new Uint8Array(buf);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      });
      return { body, contentLength: chunk.byteLength };
    }

    // ReadableStream body; content length is unknown without an extra
    // metadata round trip — callers size responses from DB records.
    return { body: value, contentLength: undefined };
  }

  async delete(key: string): Promise<void> {
    const store = await this.getStore();
    await store.delete(key);
  }

  async list(
    prefix: string,
    options?: { delimiter?: string; maxKeys?: number; token?: string }
  ): Promise<ListObjectsResult> {
    const store = await this.getStore();
    const paginate = !options?.token;
    const result = await store.list({
      prefix,
      directories: true,
      limit: options?.maxKeys,
      cursor: options?.token,
      paginate,
    });
    return {
      objects: (result.blobs || []).map((b: any) => ({
        key: b.key,
        size: 0,
        lastModified: new Date(0),
      })),
      prefixes: result.directories || [],
      nextToken: result.cursor,
    };
  }

  async createUploadUrl(key: string, options?: { expireSeconds?: number; contentType?: string }): Promise<UploadUrlResult> {
    const store = await this.getStore();
    const result = await store.createUploadUrl(key, {
      expireSeconds: options?.expireSeconds || 3600,
      contentType: options?.contentType,
    });
    return {
      url: result.url,
      key: result.key,
      expiresAt: result.expiresAt,
    };
  }

  async exists(key: string): Promise<boolean> {
    const store = await this.getStore();
    // Cheap HEAD-style probe instead of downloading the body.
    const meta = await store.getMetadata(key, { consistency: 'strong' });
    return meta !== null && meta !== undefined;
  }
}

// S3-Compatible Provider (using AWS SDK v3)
export class S3Provider implements StorageProvider {
  private s3Client: any;
  private bucket: string;

  constructor(config: StorageConfig) {
    this.bucket = config.s3Bucket!;
    this.initClient(config);
  }

  private async initClient(config: StorageConfig) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    this.s3Client = new S3Client({
      region: config.s3Region || 'auto',
      endpoint: config.s3Endpoint,
      credentials: {
        accessKeyId: config.s3AccessKeyId!,
        secretAccessKey: config.s3SecretAccessKey!
      },
      forcePathStyle: config.s3ForcePathStyle ?? true
    });
  }

  async put(key: string, body: ArrayBuffer | ReadableStream | string, options?: { contentType?: string; metadata?: Record<string, string> }): Promise<void> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const bodyBuffer = body instanceof ArrayBuffer ? Buffer.from(body) : 
                       body instanceof ReadableStream ? await this.streamToBuffer(body) :
                       Buffer.from(body);
    
    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: bodyBuffer,
      ContentType: options?.contentType,
      Metadata: options?.metadata
    }));
  }

  async get(key: string, options?: { range?: { offset: number; length: number } }): Promise<GetObjectResult | null> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: options?.range ? `bytes=${options.range.offset}-${options.range.offset + options.range.length - 1}` : undefined
      });
      
      const response = await this.s3Client.send(command);
      return {
        body: response.Body?.transformToWebStream() || null,
        contentType: response.ContentType,
        contentLength: response.ContentLength,
        metadata: response.Metadata
      };
    } catch (error: any) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await this.s3Client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key
    }));
  }

  async list(prefix: string, options?: { delimiter?: string; maxKeys?: number; token?: string }): Promise<ListObjectsResult> {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const response = await this.s3Client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
      Delimiter: options?.delimiter,
      MaxKeys: options?.maxKeys,
      ContinuationToken: options?.token
    }));
    
    return {
      objects: (response.Contents || []).map((obj: any) => ({
        key: obj.Key,
        size: obj.Size,
        lastModified: obj.LastModified,
        contentType: undefined // Would need HEAD request for each
      })),
      prefixes: (response.CommonPrefixes || []).map((p: any) => p.Prefix),
      nextToken: response.NextContinuationToken
    };
  }

  async createUploadUrl(key: string, options?: { expireSeconds?: number; contentType?: string }): Promise<UploadUrlResult> {
    const { PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: options?.contentType
    });
    
    const url = await getSignedUrl(this.s3Client, command, { expiresIn: options?.expireSeconds || 3600 });
    
    return {
      url,
      key,
      expiresAt: Date.now() + (options?.expireSeconds || 3600) * 1000
    };
  }

  async exists(key: string): Promise<boolean> {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      await this.s3Client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key
      }));
      return true;
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  private async streamToBuffer(stream: ReadableStream): Promise<Buffer> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
}

// Factory function
export async function createStorageProvider(env: any): Promise<StorageProvider> {
  const config: StorageConfig = {
    type: (env.STORAGE_TYPE as 'blob' | 's3') || 'blob',
    blobStoreName: env.BLOB_STORE_NAME || 'memos',
    s3Endpoint: env.S3_ENDPOINT,
    s3Region: env.S3_REGION,
    s3Bucket: env.S3_BUCKET,
    s3AccessKeyId: env.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY,
    s3ForcePathStyle: env.S3_FORCE_PATH_STYLE === 'true'
  };

  if (config.type === 's3') {
    if (!config.s3Endpoint || !config.s3Bucket || !config.s3AccessKeyId || !config.s3SecretAccessKey) {
      throw new Error('S3 configuration incomplete: requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY');
    }
    return new S3Provider(config);
  }
  
  return new EdgeOneBlobProvider(config.blobStoreName!);
}