/**
 * Middleware to initialize database and storage providers
 * Uses Blob storage for everything (no external database)
 */

import type { Env } from "../types";
import { createBlobDatabase, BlobDatabase } from "../db/blob-database";
import { createStorageProvider, StorageProvider } from "../storage";

export async function initProviders(c: any, next: () => Promise<void>) {
  // Initialize storage if not already done
  if (!c.env.BUCKET) {
    c.env.BUCKET = await createStorageProvider(c.env);
  }

  // Initialize database if not already done
  if (!c.env.DB) {
    const db = createBlobDatabase(c.env.BUCKET);
    await db.init();
    c.env.DB = db;
  }

  await next();
}

// Helper to get initialized providers
export async function getProviders(env: Env) {
  const storage = await createStorageProvider(env);
  const db = createBlobDatabase(storage);
  await db.init();
  
  return { db, storage };
}