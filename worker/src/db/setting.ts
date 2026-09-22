export interface UserSettingRow {
  user_id: number;
  key: string;
  value: string;
}

export async function getUserSetting(
  db: D1Database,
  userId: number,
  key: string
): Promise<UserSettingRow | null> {
  return db
    .prepare("SELECT * FROM user_setting WHERE user_id = ? AND key = ?")
    .bind(userId, key)
    .first<UserSettingRow>();
}

export async function listUserSettings(
  db: D1Database,
  userId: number
): Promise<UserSettingRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM user_setting WHERE user_id = ?")
    .bind(userId)
    .all<UserSettingRow>();
  return results;
}

export async function setUserSetting(
  db: D1Database,
  userId: number,
  key: string,
  value: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO user_setting (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value"
    )
    .bind(userId, key, value)
    .run();
}

export async function deleteUserSetting(
  db: D1Database,
  userId: number,
  key: string
): Promise<void> {
  await db
    .prepare("DELETE FROM user_setting WHERE user_id = ? AND key = ?")
    .bind(userId, key)
    .run();
}

// --- System Settings ---

export interface SystemSettingRow {
  name: string;
  value: string;
  description: string;
}

export async function getSystemSetting(
  db: D1Database,
  name: string
): Promise<SystemSettingRow | null> {
  return db
    .prepare("SELECT * FROM system_setting WHERE name = ?")
    .bind(name)
    .first<SystemSettingRow>();
}

export async function listSystemSettings(
  db: D1Database
): Promise<SystemSettingRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM system_setting")
    .all<SystemSettingRow>();
  return results;
}

export async function setSystemSetting(
  db: D1Database,
  name: string,
  value: string,
  description?: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO system_setting (name, value, description) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value"
    )
    .bind(name, value, description || "")
    .run();
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
  const candidates = getInstanceSettingStorageNames(name);
  const placeholders = candidates.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT * FROM system_setting WHERE name IN (${placeholders})`)
    .bind(...candidates)
    .all<SystemSettingRow>();

  for (const candidate of candidates) {
    const setting = results.find((row) => row.name === candidate);
    if (!setting) continue;
    return {
      ...setting,
      name: normalizeInstanceSettingName(setting.name),
    };
  }
  return null;
}
