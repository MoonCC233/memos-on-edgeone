/**
 * Settings Database — Blob storage facade.
 *
 * All reads/writes go through BlobSettingsStore (settings/instance.json and
 * settings/users/{id}.json in Blob), which is also what the instance settings
 * UI and user settings endpoints write to. The legacy D1 `system_setting` /
 * `user_setting` SQL tables are gone — everything lives in Blob.
 *
 * Function signatures keep the old (db, ...) shape so route call sites are
 * unchanged; `db` is the BlobDatabase, whose public `storage` provider is
 * shared with all other blob access.
 */

import { BlobSettingsStore, SystemSetting, UserSetting } from "./settings-blob";

export interface UserSettingRow {
  user_id: number;
  key: string;
  value: string;
}

function store(db: D1Database): BlobSettingsStore {
  return new BlobSettingsStore(db.storage);
}

export async function getUserSetting(
  db: D1Database,
  userId: number,
  key: string
): Promise<UserSettingRow | null> {
  return store(db).getUserSetting(userId, key);
}

export async function listUserSettings(
  db: D1Database,
  userId: number
): Promise<UserSettingRow[]> {
  return store(db).getUserSettings(userId);
}

export async function setUserSetting(
  db: D1Database,
  userId: number,
  key: string,
  value: string
): Promise<void> {
  return store(db).setUserSetting(userId, key, value);
}

export async function deleteUserSetting(
  db: D1Database,
  userId: number,
  key: string
): Promise<void> {
  return store(db).deleteUserSetting(userId, key);
}

// --- Instance settings ---

export interface SystemSettingRow {
  name: string;
  value: string;
  description: string;
}

export async function getSystemSetting(
  db: D1Database,
  name: string
): Promise<SystemSettingRow | null> {
  return store(db).getInstanceSetting(name);
}

export async function listSystemSettings(
  db: D1Database
): Promise<SystemSettingRow[]> {
  return store(db).getAllInstanceSettings();
}

export async function setSystemSetting(
  db: D1Database,
  name: string,
  value: string,
  description?: string
): Promise<void> {
  return store(db).setInstanceSetting(name, value, description);
}

const INSTANCE_SETTING_PREFIX = "instance/settings/";

export function normalizeInstanceSettingName(name: string): string {
  if (!name) {
    return "";
  }
  return name.startsWith(INSTANCE_SETTING_PREFIX) ? name : `${INSTANCE_SETTING_PREFIX}${name}`;
}

export function getInstanceSettingStorageNames(name: string): string[] {
  const normalizedName = normalizeInstanceSettingName(name);
  const legacyName = normalizedName.startsWith(INSTANCE_SETTING_PREFIX) ? normalizedName.slice(INSTANCE_SETTING_PREFIX.length) : normalizedName;
  return legacyName === normalizedName ? [normalizedName] : [normalizedName, legacyName];
}

export async function getInstanceSetting(
  db: D1Database,
  name: string
): Promise<SystemSettingRow | null> {
  // BlobSettingsStore matches exact names and bare last-segment names, so
  // both "GENERAL" and "instance/settings/GENERAL" resolve to the same row.
  return store(db).getInstanceSetting(name);
}
