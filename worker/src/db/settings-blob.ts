/**
 * Settings Storage using Blob
 * Replaces D1-based settings with Blob storage for all configuration
 */

import { createStorageProvider, StorageProvider } from '../storage';

const SETTINGS_PREFIX = 'settings/';
const INSTANCE_SETTINGS_KEY = 'settings/instance.json';
const USER_SETTINGS_PREFIX = 'settings/users/';

export interface SystemSetting {
  name: string;
  value: string;
  description: string;
}

export interface UserSetting {
  user_id: number;
  key: string;
  value: string;
}

export class BlobSettingsStore {
  private storage: StorageProvider;

  constructor(storage: StorageProvider) {
    this.storage = storage;
  }

  // Instance settings
  async getInstanceSetting(name: string): Promise<SystemSetting | null> {
    const all = await this.getAllInstanceSettings();
    const exact = all.find(s => s.name === name);
    if (exact) return exact;
    // The frontend stores full "instance/settings/KEY" names, while backend
    // callers often pass a bare "KEY" — match on the last path segment.
    const bare = (n: string) => n.split('/').pop() || n;
    return all.find(s => bare(s.name) === bare(name)) || null;
  }

  async getAllInstanceSettings(): Promise<SystemSetting[]> {
    try {
      const result = await this.storage.get(INSTANCE_SETTINGS_KEY);
      if (!result || !result.body) return [];
      const data = await this.parseJsonBody(result.body);
      return data.settings || [];
    } catch {
      return [];
    }
  }

  async setInstanceSetting(name: string, value: string, description?: string): Promise<void> {
    const all = await this.getAllInstanceSettings();
    const index = all.findIndex(s => s.name === name);
    const setting: SystemSetting = { name, value, description: description || '' };
    
    if (index >= 0) {
      all[index] = setting;
    } else {
      all.push(setting);
    }
    
    await this.storage.put(INSTANCE_SETTINGS_KEY, JSON.stringify({ settings: all }), { contentType: 'application/json' });
  }

  async deleteInstanceSetting(name: string): Promise<void> {
    const all = await this.getAllInstanceSettings();
    const filtered = all.filter(s => s.name !== name);
    await this.storage.put(INSTANCE_SETTINGS_KEY, JSON.stringify({ settings: filtered }), { contentType: 'application/json' });
  }

  // User settings
  async getUserSetting(userId: number, key: string): Promise<UserSetting | null> {
    const all = await this.getUserSettings(userId);
    return all.find(s => s.key === key) || null;
  }

  async getUserSettings(userId: number): Promise<UserSetting[]> {
    const key = `${USER_SETTINGS_PREFIX}${userId}.json`;
    try {
      const result = await this.storage.get(key);
      if (!result || !result.body) return [];
      const data = await this.parseJsonBody(result.body);
      return data.settings || [];
    } catch {
      return [];
    }
  }

  async setUserSetting(userId: number, key: string, value: string): Promise<void> {
    const all = await this.getUserSettings(userId);
    const index = all.findIndex(s => s.key === key);
    const setting: UserSetting = { user_id: userId, key, value };
    
    if (index >= 0) {
      all[index] = setting;
    } else {
      all.push(setting);
    }
    
    const keyPath = `${USER_SETTINGS_PREFIX}${userId}.json`;
    await this.storage.put(keyPath, JSON.stringify({ settings: all }), { contentType: 'application/json' });
  }

  async deleteUserSetting(userId: number, key: string): Promise<void> {
    const all = await this.getUserSettings(userId);
    const filtered = all.filter(s => s.key !== key);
    const keyPath = `${USER_SETTINGS_PREFIX}${userId}.json`;
    await this.storage.put(keyPath, JSON.stringify({ settings: filtered }), { contentType: 'application/json' });
  }

  /**
   * Find one setting with the given key across ALL users' settings files.
   * Used by PAT (personal access token) auth — tokens are stored in the blob
   * settings store, not the legacy user_setting table.
   */
  async findUserSettingsByKey(key: string): Promise<UserSetting[]> {
    try {
      const listed = await this.storage.list(USER_SETTINGS_PREFIX);
      const out: UserSetting[] = [];
      for (const obj of listed.objects) {
        try {
          const result = await this.storage.get(obj.key);
          if (!result || !result.body) continue;
          const data = await this.parseJsonBody(result.body);
          for (const s of (data.settings || []) as UserSetting[]) {
            if (s.key === key) out.push(s);
          }
        } catch {
          // Skip unreadable individual settings files.
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  // Migration helper - import from database
  async migrateFromDatabase(dbSettings: SystemSetting[], dbUserSettings: Map<number, UserSetting[]>): Promise<void> {
    // Migrate instance settings
    if (dbSettings.length > 0) {
      await this.storage.put(INSTANCE_SETTINGS_KEY, JSON.stringify({ settings: dbSettings }), { contentType: 'application/json' });
    }
    
    // Migrate user settings
    for (const [userId, settings] of dbUserSettings.entries()) {
      if (settings.length > 0) {
        const keyPath = `${USER_SETTINGS_PREFIX}${userId}.json`;
        await this.storage.put(keyPath, JSON.stringify({ settings }), { contentType: 'application/json' });
      }
    }
  }

  private async parseJsonBody(body: ReadableStream | ArrayBuffer | string): Promise<any> {
    if (typeof body === 'string') return JSON.parse(body);
    if (body instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(body));
    // ReadableStream
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const combined = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(combined));
  }
}

// Factory function
export async function createSettingsStore(env: any): Promise<BlobSettingsStore> {
  const storage = await createStorageProvider(env);
  return new BlobSettingsStore(storage);
}