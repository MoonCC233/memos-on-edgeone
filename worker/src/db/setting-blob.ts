/**
 * Settings Database - Blob Storage Backend
 * Provides the same interface as the original D1-based settings but uses Blob storage
 */

import { BlobSettingsStore, SystemSetting, UserSetting } from "./settings-blob";

// Re-export types for compatibility
export type UserSettingRow = UserSetting;
export type SystemSettingRow = SystemSetting;

// These functions now use BlobSettingsStore instead of D1Database
// They're called with the BlobSettingsStore instance from the context

export async function getUserSetting(
  store: BlobSettingsStore,
  userId: number,
  key: string
): Promise<UserSettingRow | null> {
  return store.getUserSetting(userId, key);
}

export async function listUserSettings(
  store: BlobSettingsStore,
  userId: number
): Promise<UserSettingRow[]> {
  return store.getUserSettings(userId);
}

export async function setUserSetting(
  store: BlobSettingsStore,
  userId: number,
  key: string,
  value: string
): Promise<void> {
  return store.setUserSetting(userId, key, value);
}

export async function deleteUserSetting(
  store: BlobSettingsStore,
  userId: number,
  key: string
): Promise<void> {
  return store.deleteUserSetting(userId, key);
}

// --- System Settings ---

export async function getSystemSetting(
  store: BlobSettingsStore,
  name: string
): Promise<SystemSettingRow | null> {
  return store.getInstanceSetting(name);
}

export async function listSystemSettings(
  store: BlobSettingsStore
): Promise<SystemSettingRow[]> {
  return store.getAllInstanceSettings();
}

export async function setSystemSetting(
  store: BlobSettingsStore,
  name: string,
  value: string,
  description?: string
): Promise<void> {
  return store.setInstanceSetting(name, value, description);
}

// Instance setting helpers (same as before for compatibility)
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
  store: BlobSettingsStore,
  name: string
): Promise<SystemSettingRow | null> {
  // The BlobSettingsStore handles normalization internally
  return store.getInstanceSetting(name);
}