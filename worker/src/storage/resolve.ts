/**
 * Attachment storage resolver.
 *
 * The database (and everything else) always lives on `env.BUCKET` — attached
 * lazily per request by initProviders. New attachments can additionally be
 * redirected to an S3-compatible bucket configured through the STORAGE
 * instance setting (设置 → 存储), which is persisted in Blob next to the
 * other instance settings.
 *
 * Every attachment row records the backend it was written to
 * (`storage_type`), so reads and deletes keep resolving the right backend
 * after the setting changes:
 *   - "BLOB" → the deployment default storage (`env.BUCKET`)
 *   - "S3"   → the S3 bucket from the STORAGE instance setting
 */
import type { Env } from "../types";
import * as settingDB from "../db/setting";
import { S3Provider, StorageProvider } from "./index";

/** StorageSetting.StorageType.S3 in the proto enum. */
const STORAGE_TYPE_S3 = 3;

export interface StorageS3Config {
  accessKeyId?: string;
  accessKeySecret?: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  usePathStyle?: boolean;
}

export interface StorageSettingValue {
  storageType?: number | string;
  filepathTemplate?: string;
  uploadSizeLimitMb?: number;
  s3Config?: StorageS3Config;
}

async function readStorageSetting(env: Env): Promise<StorageSettingValue | null> {
  // fnEnv is a fresh object per request (see cloud-functions/handler.ts), so
  // this memo only deduplicates reads within a single request — an updated
  // setting is always visible to the next request.
  const memo = (env as any).__storageSetting;
  if (memo !== undefined) {
    return memo as StorageSettingValue | null;
  }

  let parsed: StorageSettingValue | null = null;
  try {
    const row = await settingDB.getInstanceSetting(env.DB, "STORAGE");
    if (row?.value) {
      const value = JSON.parse(row.value);
      if (value && typeof value === "object") {
        parsed = value;
      }
    }
  } catch {
    parsed = null;
  }

  (env as any).__storageSetting = parsed;
  return parsed;
}

function createS3Provider(cfg: StorageS3Config): S3Provider | null {
  if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.accessKeySecret) {
    return null;
  }
  return new S3Provider({
    type: "s3",
    s3Endpoint: cfg.endpoint,
    s3Region: cfg.region,
    s3Bucket: cfg.bucket,
    s3AccessKeyId: cfg.accessKeyId,
    s3SecretAccessKey: cfg.accessKeySecret,
    s3ForcePathStyle: cfg.usePathStyle ?? true,
  });
}

function isS3Selected(setting: StorageSettingValue | null): boolean {
  if (!setting) return false;
  return setting.storageType === "S3" || Number(setting.storageType) === STORAGE_TYPE_S3;
}

/**
 * Where NEW attachments should be written, plus the `storage_type` label to
 * record on the attachment row.
 */
export async function getAttachmentWriteStorage(
  env: Env
): Promise<{ storage: StorageProvider; storageType: "BLOB" | "S3" }> {
  const setting = await readStorageSetting(env);
  if (isS3Selected(setting)) {
    const provider = setting?.s3Config ? createS3Provider(setting.s3Config) : null;
    if (!provider) {
      throw new Error(
        "S3 storage is selected but the STORAGE instance setting has no complete S3 configuration"
      );
    }
    return { storage: provider, storageType: "S3" };
  }
  return { storage: env.BUCKET, storageType: "BLOB" };
}

/**
 * Storage backend holding the file recorded by an attachment row. Falls back
 * to the default storage when the S3 configuration is unavailable so reads
 * degrade to a 404 instead of an error.
 */
export async function getAttachmentStorage(
  env: Env,
  storageType?: string | null
): Promise<StorageProvider> {
  if (storageType === "S3") {
    const setting = await readStorageSetting(env);
    const provider = setting?.s3Config ? createS3Provider(setting.s3Config) : null;
    if (provider) return provider;
  }
  return env.BUCKET;
}
