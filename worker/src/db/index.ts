/**
 * Database Abstraction Layer using Turso (libSQL)
 * Compatible with SQLite queries used in the original project
 */

import { createClient } from '@libsql/client';

export interface DatabaseConfig {
  url: string;
  authToken?: string;
}

export interface QueryResult<T = any> {
  rows: T[];
  rowsAffected: number;
  lastInsertRowid: number;
}

export interface DatabaseProvider {
  execute(sql: string, params?: any[]): Promise<QueryResult>;
  executeBatch(statements: Array<{ sql: string; params?: any[] }>): Promise<QueryResult[]>;
  transaction<T>(callback: (tx: DatabaseProvider) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class TursoDatabaseProvider implements DatabaseProvider {
  private client: any;

  constructor(config: DatabaseConfig) {
    this.client = createClient({
      url: config.url,
      authToken: config.authToken
    });
  }

  async execute(sql: string, params: any[] = []): Promise<QueryResult> {
    const result = await this.client.execute({ sql, args: params });
    return {
      rows: result.rows as any[],
      rowsAffected: result.rowsAffected,
      lastInsertRowid: result.lastInsertRowid
    };
  }

  async executeBatch(statements: Array<{ sql: string; params?: any[] }>): Promise<QueryResult[]> {
    const batch = statements.map(s => ({ sql: s.sql, args: s.params || [] }));
    const results = await this.client.batch(batch);
    return results.map((r: any) => ({
      rows: r.rows as any[],
      rowsAffected: r.rowsAffected,
      lastInsertRowid: r.lastInsertRowid
    }));
  }

  async transaction<T>(callback: (tx: DatabaseProvider) => Promise<T>): Promise<T> {
    return await this.client.transaction(async (tx: any) => {
      const txProvider = new TransactionDatabaseProvider(tx);
      return await callback(txProvider);
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

class TransactionDatabaseProvider implements DatabaseProvider {
  constructor(private tx: any) {}

  async execute(sql: string, params: any[] = []): Promise<QueryResult> {
    const result = await this.tx.execute({ sql, args: params });
    return {
      rows: result.rows as any[],
      rowsAffected: result.rowsAffected,
      lastInsertRowid: result.lastInsertRowid
    };
  }

  async executeBatch(statements: Array<{ sql: string; params?: any[] }>): Promise<QueryResult[]> {
    const batch = statements.map(s => ({ sql: s.sql, args: s.params || [] }));
    const results = await this.tx.batch(batch);
    return results.map((r: any) => ({
      rows: r.rows as any[],
      rowsAffected: r.rowsAffected,
      lastInsertRowid: r.lastInsertRowid
    }));
  }

  async transaction<T>(callback: (tx: DatabaseProvider) => Promise<T>): Promise<T> {
    // Nested transactions not supported, just execute directly
    return await callback(this);
  }

  async close(): Promise<void> {
    // Transaction closed by parent
  }
}

// Factory function
export function createDatabaseProvider(env: any): DatabaseProvider {
  const url = env.TURSO_DATABASE_URL;
  const authToken = env.TURSO_AUTH_TOKEN;
  
  if (!url) {
    throw new Error('TURSO_DATABASE_URL is required');
  }
  
  return new TursoDatabaseProvider({ url, authToken });
}

// Migration helper - applies SQL migrations
export async function runMigrations(db: DatabaseProvider, migrations: string[]): Promise<void> {
  // Create migration tracking table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `);
  
  const applied = await db.execute('SELECT name FROM _migrations');
  const appliedSet = new Set(applied.rows.map((r: any) => r.name));
  
  for (const migration of migrations) {
    if (!appliedSet.has(migration)) {
      // In a real implementation, you'd load the SQL from files
      console.log(`Applying migration: ${migration}`);
      // await db.execute(migrationSQL);
      await db.execute('INSERT INTO _migrations (name) VALUES (?)', [migration]);
    }
  }
}

// Schema initialization (run once on first deploy)
export const INITIAL_SCHEMA = `
-- Memos on EdgeOne Schema
-- Adapted from memos SQLite schema, using Turso (libSQL) for database and Blob for file storage

CREATE TABLE IF NOT EXISTS system_setting (
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  row_status TEXT NOT NULL CHECK (row_status IN ('NORMAL', 'ARCHIVED')) DEFAULT 'NORMAL',
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'USER',
  email TEXT NOT NULL DEFAULT '',
  nickname TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS user_setting (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(user_id, key)
);

CREATE TABLE IF NOT EXISTS memo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  creator_id INTEGER NOT NULL,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  row_status TEXT NOT NULL CHECK (row_status IN ('NORMAL', 'ARCHIVED')) DEFAULT 'NORMAL',
  content TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC', 'PROTECTED', 'PRIVATE')) DEFAULT 'PRIVATE',
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)) DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS memo_relation (
  memo_id INTEGER NOT NULL,
  related_memo_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  UNIQUE(memo_id, related_memo_id, type)
);

CREATE TABLE IF NOT EXISTS attachment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  creator_id INTEGER NOT NULL,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  filename TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  memo_id INTEGER,
  storage_type TEXT NOT NULL DEFAULT 'BLOB',
  reference TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS idp (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  identifier_filter TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  sender_id INTEGER NOT NULL,
  receiver_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS reaction (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  creator_id INTEGER NOT NULL,
  content_id TEXT NOT NULL,
  reaction_type TEXT NOT NULL,
  UNIQUE(creator_id, content_id, reaction_type)
);

CREATE TABLE IF NOT EXISTS memo_share (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  memo_id INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  expires_ts BIGINT DEFAULT NULL,
  FOREIGN KEY (memo_id) REFERENCES memo(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memo_share_memo_id ON memo_share(memo_id);

CREATE TABLE IF NOT EXISTS user_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  extern_uid TEXT NOT NULL,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  UNIQUE (provider, extern_uid),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_user_identity_user_id ON user_identity(user_id);

CREATE TABLE IF NOT EXISTS webhook (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  url TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (creator_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webhook_creator_id ON webhook(creator_id);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_memo_status_pinned_created
  ON memo(row_status, pinned, created_ts DESC);

CREATE INDEX IF NOT EXISTS idx_memo_creator_status_pinned_created
  ON memo(creator_id, row_status, pinned, created_ts DESC);

CREATE INDEX IF NOT EXISTS idx_memo_visibility_status_created
  ON memo(visibility, row_status, created_ts DESC);

CREATE INDEX IF NOT EXISTS idx_attachment_creator_created
  ON attachment(creator_id, created_ts DESC);

CREATE INDEX IF NOT EXISTS idx_attachment_memo_id
  ON attachment(memo_id);

CREATE INDEX IF NOT EXISTS idx_memo_relation_memo_type
  ON memo_relation(memo_id, type);

CREATE INDEX IF NOT EXISTS idx_memo_relation_related_type
  ON memo_relation(related_memo_id, type);

CREATE INDEX IF NOT EXISTS idx_reaction_content_created
  ON reaction(content_id, created_ts ASC);

CREATE INDEX IF NOT EXISTS idx_inbox_receiver_status_created
  ON inbox(receiver_id, status, created_ts DESC);
`;