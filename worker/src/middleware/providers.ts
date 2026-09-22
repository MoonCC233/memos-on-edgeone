/**
 * Middleware to initialize database and storage providers
 * Makes them available via c.env.DB and c.env.BUCKET
 */

import { Hono } from "hono";
import type { Env, D1Database } from "../types";
import { createDatabaseProvider, DatabaseProvider, D1DatabaseWrapper } from "../db";
import { createStorageProvider, StorageProvider } from "../storage";

// Extend Env with initialized providers
declare module "hono" {
  interface Env {
    DB: D1Database;
    BUCKET: StorageProvider;
  }
}

export async function initProviders(c: any, next: () => Promise<void>) {
  // Initialize database if not already done
  if (!c.env.DB) {
    const dbProvider = createDatabaseProvider(c.env);
    c.env.DB = new D1DatabaseWrapper(dbProvider);
  }

  // Initialize storage if not already done
  if (!c.env.BUCKET) {
    c.env.BUCKET = await createStorageProvider(c.env);
  }

  await next();
}

// Helper to get initialized providers
export function getProviders(env: Env) {
  return {
    db: createDatabaseProvider(env),
    storage: createStorageProvider(env)
  };
}