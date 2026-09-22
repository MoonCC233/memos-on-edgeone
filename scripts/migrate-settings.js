#!/usr/bin/env node
/**
 * Migrate settings from D1 (system_setting, user_setting tables) to Blob storage
 * Run after creating Turso database and importing data from Cloudflare D1
 */

import { createClient } from '@libsql/client';
import { createStorageProvider } from '../worker/src/storage';
import { BlobSettingsStore } from '../worker/src/db/settings-blob';

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const blobStoreName = process.env.BLOB_STORE_NAME || 'memos';
  
  if (!url) {
    console.error('Error: TURSO_DATABASE_URL environment variable is required');
    process.exit(1);
  }
  
  console.log('Connecting to Turso database...');
  const db = createClient({ url, authToken });
  
  console.log('Initializing Blob storage...');
  const storage = await createStorageProvider({ BLOB_STORE_NAME: blobStoreName });
  const settingsStore = new BlobSettingsStore(storage);
  
  try {
    // 1. Migrate system settings
    console.log('\n=== Migrating System Settings ===');
    const systemSettingsResult = await db.execute('SELECT * FROM system_setting');
    const systemSettings = systemSettingsResult.rows.map(row => ({
      name: row.name,
      value: row.value,
      description: row.description || ''
    }));
    
    if (systemSettings.length > 0) {
      await settingsStore.migrateFromDatabase(systemSettings, new Map());
      console.log(`✓ Migrated ${systemSettings.length} system settings to Blob`);
    } else {
      console.log('No system settings to migrate');
    }
    
    // 2. Migrate user settings
    console.log('\n=== Migrating User Settings ===');
    const userSettingsResult = await db.execute('SELECT * FROM user_setting');
    const userSettingsByUser = new Map();
    
    for (const row of userSettingsResult.rows) {
      const userId = row.user_id;
      if (!userSettingsByUser.has(userId)) {
        userSettingsByUser.set(userId, []);
      }
      userSettingsByUser.get(userId).push({
        user_id: userId,
        key: row.key,
        value: row.value
      });
    }
    
    if (userSettingsByUser.size > 0) {
      await settingsStore.migrateFromDatabase([], userSettingsByUser);
      console.log(`✓ Migrated settings for ${userSettingsByUser.size} users to Blob`);
    } else {
      console.log('No user settings to migrate');
    }
    
    console.log('\n=== Migration Complete ===');
    console.log('All settings have been migrated to Blob storage.');
    console.log('You can now deploy to EdgeOne Makers.');
    
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

main();