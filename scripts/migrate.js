#!/usr/bin/env node
/**
 * Migration script for Turso (libSQL) database
 * Replaces wrangler d1 migrations for EdgeOne deployment
 */

import { createClient } from '@libsql/client';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

async function main() {
  const args = process.argv.slice(2);
  const isRemote = args.includes('--remote');
  
  const url = isRemote ? process.env.TURSO_DATABASE_URL : process.env.TURSO_DATABASE_URL_LOCAL;
  const authToken = isRemote ? process.env.TURSO_AUTH_TOKEN : process.env.TURSO_AUTH_TOKEN_LOCAL;
  
  if (!url) {
    console.error('Error: TURSO_DATABASE_URL' + (isRemote ? '' : '_LOCAL') + ' environment variable is required');
    process.exit(1);
  }
  
  const client = createClient({ url, authToken });
  
  // Create migrations tracking table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `);
  
  // Get applied migrations
  const appliedResult = await client.execute('SELECT name FROM _migrations');
  const appliedMigrations = new Set(appliedResult.rows.map((r: any) => r.name));
  
  // Read migration files
  const migrationsDir = join(process.cwd(), 'migrations');
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();
  
  for (const file of files) {
    if (appliedMigrations.has(file)) {
      console.log(`Skipping already applied migration: ${file}`);
      continue;
    }
    
    console.log(`Applying migration: ${file}`);
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    
    try {
      // Split by semicolon and execute each statement
      const statements = sql.split(';').filter(s => s.trim());
      for (const stmt of statements) {
        if (stmt.trim()) {
          await client.execute(stmt);
        }
      }
      
      // Record migration
      await client.execute('INSERT INTO _migrations (name) VALUES (?)', [file]);
      console.log(`Applied migration: ${file}`);
    } catch (error) {
      console.error(`Failed to apply migration ${file}:`, error);
      process.exit(1);
    }
  }
  
  console.log('All migrations applied successfully!');
  await client.close();
}

main().catch(console.error);