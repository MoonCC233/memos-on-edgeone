import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authOptional, authRequired } from "../middleware/auth";
import * as userDB from "../db/user";
import { getAppVersion } from "../version";
import { deleteCachedKeys, getCachedJson, putCachedJson } from "../cache";
import { BlobSettingsStore, createSettingsStore } from "../db/settings-blob";

type InstApp = { Bindings: Env; Variables: { user: UserPayload } };

export const instanceRoutes = new Hono<InstApp>();

const PUBLIC_INSTANCE_SETTING_KEYS = new Set(["GENERAL", "MEMO_RELATED", "TAGS", "AI"]);

function getInstanceSettingKey(name: string): string {
  return name.split("/").pop() || "";
}

function sanitizePublicInstanceSettingValue(name: string, value: string): string {
  const key = getInstanceSettingKey(name);
  if (key !== "AI") {
    return value;
  }

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") {
      return "{}";
    }

    const next = {
      ...parsed,
      providers: Array.isArray((parsed as { providers?: unknown[] }).providers)
        ? (parsed as { providers: Array<{ apiKeySet?: boolean; apiKeyHint?: string; [key: string]: unknown }> }).providers.map((provider) => ({
            ...provider,
            apiKey: "",
            apiKeySet: Boolean(provider.apiKeySet || provider.apiKey),
            apiKeyHint: provider.apiKeyHint || (provider.apiKeySet || provider.apiKey ? "configured" : ""),
          }))
        : [],
    };

    return JSON.stringify(next);
  } catch {
    return "{}";
  }
}

// STORAGE (设置 → 存储) holds S3 credentials. The secret key never leaves the
// server: responses carry `accessKeySecretSet` instead, and a blank/absent
// secret on update means "keep the stored one". Idempotent — re-sanitizing an
// already-sanitized value preserves the flag.
function sanitizeStorageSettingValue(value: string): string {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") {
      return "{}";
    }
    if (!parsed.s3Config || typeof parsed.s3Config !== "object") {
      return JSON.stringify(parsed);
    }
    const cfg = { ...parsed.s3Config };
    const secretSet = Boolean(cfg.accessKeySecret) || cfg.accessKeySecretSet === true;
    delete cfg.accessKeySecret;
    delete cfg.accessKeySecretSet;
    return JSON.stringify({ ...parsed, s3Config: { ...cfg, accessKeySecretSet: secretSet } });
  } catch {
    return "{}";
  }
}

function sanitizeSettingsList(list: Array<{ name: string; value: string; description?: string }>) {
  return list.map((setting) =>
    getInstanceSettingKey(setting.name) === "STORAGE"
      ? { ...setting, value: sanitizeStorageSettingValue(setting.value) }
      : setting
  );
}

// Helper to get settings store from context (async — createSettingsStore
// initializes the storage provider lazily)
async function getSettingsStore(c: any): Promise<BlobSettingsStore> {
  if (!c.settingsStore) {
    c.settingsStore = await createSettingsStore(c.env);
  }
  return c.settingsStore;
}

// Get instance profile
instanceRoutes.get("/profile", async (c) => {
  const cached = await getCachedJson(c.env.CACHE, "instance:profile");
  if (cached) {
    return c.json(cached);
  }

  const userCount = await userDB.countUsers(c.env.DB);
  const settingsStore = await getSettingsStore(c);
  const generalSetting = await settingsStore.getInstanceSetting("GENERAL");
  let profile = {};
  if (generalSetting) {
    try {
      profile = JSON.parse(generalSetting.value)?.customProfile || {};
    } catch {
      profile = {};
    }
  }

  let admin = undefined;
  if (userCount > 0) {
    const adminUser = await c.env.DB.prepare(
      "SELECT * FROM user WHERE role = 'ADMIN' ORDER BY created_ts ASC LIMIT 1"
    ).first<any>();
    if (adminUser) {
      admin = {
        name: `users/${adminUser.username}`,
        username: adminUser.username,
        nickname: adminUser.nickname,
        role: 2,
      };
    }
  }

  const response = {
    version: getAppVersion(c.env),
    mode: "prod",
    admin,
    ...profile,
  };

  await putCachedJson(c.env.CACHE, "instance:profile", response, 600);
  return c.json(response);
});

// List instance settings
instanceRoutes.get("/settings", authRequired, async (c) => {
  const currentUser = c.get("user");
  if (currentUser.role !== "ADMIN") {
    return c.json({ error: "Admin only" }, 403);
  }

  const cached = (await getCachedJson(c.env.CACHE, "instance:settings")) as
    | { settings?: Array<{ name: string; value: string; description?: string }> }
    | null;
  if (cached) {
    if (Array.isArray(cached.settings)) {
      cached.settings = sanitizeSettingsList(cached.settings);
    }
    return c.json(cached);
  }

  const settingsStore = await getSettingsStore(c);
  const settings = await settingsStore.getAllInstanceSettings();
  const response = {
    settings: sanitizeSettingsList(
      settings.map((setting) => ({
        ...setting,
        name: setting.name,
      }))
    ),
  };

  await putCachedJson(c.env.CACHE, "instance:settings", response, 300);
  return c.json(response);
});

// Get instance setting
instanceRoutes.get("/settings/*", authOptional, async (c) => {
  const fullPath = c.req.path;
  const name = fullPath.replace("/api/v1/instance/settings/", "");
  const key = getInstanceSettingKey(name);
  const currentUser = c.get("user");
  const isAdmin = currentUser?.role === "ADMIN";
  if (!PUBLIC_INSTANCE_SETTING_KEYS.has(key) && !isAdmin) {
    return c.json({ error: "Admin only" }, 403);
  }

  const cacheKey = key === "AI" ? `instance:setting:${name}:${isAdmin ? "admin" : "public"}` : `instance:setting:${name}`;
  const cached = (await getCachedJson(c.env.CACHE, cacheKey)) as { name?: string; value?: string } | null;
  if (cached) {
    if (key === "STORAGE" && typeof cached.value === "string") {
      cached.value = sanitizeStorageSettingValue(cached.value);
    }
    return c.json(cached);
  }

  const settingsStore = await getSettingsStore(c);
  const setting = await settingsStore.getInstanceSetting(name);
  if (!setting) {
    const response = { name, value: "{}" };
    await putCachedJson(c.env.CACHE, cacheKey, response, 300);
    return c.json(response);
  }
  const value =
    key === "STORAGE"
      ? sanitizeStorageSettingValue(setting.value)
      : PUBLIC_INSTANCE_SETTING_KEYS.has(key) && !isAdmin
        ? sanitizePublicInstanceSettingValue(key, setting.value)
        : setting.value;
  const response = {
    name: setting.name,
    value,
  };
  await putCachedJson(c.env.CACHE, cacheKey, response, 300);
  return c.json(response);
});

// Test email setting via Resend (admin only)
instanceRoutes.post("/settings/notification\\:testEmail", authRequired, async (c) => {
  const currentUser = c.get("user");
  if (currentUser.role !== "ADMIN") {
    return c.json({ error: "Admin only" }, 403);
  }

  const body = await c.req.json<{ email?: { apiKey?: string; fromEmail?: string; fromName?: string }; recipientEmail?: string }>();

  let apiKey = body.email?.apiKey;
  let fromEmail = body.email?.fromEmail;
  let fromName = body.email?.fromName;

  if (!apiKey || !fromEmail) {
    const settingsStore = await getSettingsStore(c);
    const setting = await settingsStore.getInstanceSetting("NOTIFICATION");
    if (setting) {
      const parsed = JSON.parse(setting.value);
      const email = parsed.email || {};
      if (!apiKey) apiKey = email.apiKey;
      if (!fromEmail) fromEmail = email.fromEmail;
      if (!fromName) fromName = email.fromName;
    }
  }

  if (!apiKey || !fromEmail) {
    return c.json({ error: "Resend API key and from email are required" }, 400);
  }

  const recipientEmail = body.recipientEmail;
  if (!recipientEmail) {
    return c.json({ error: "Recipient email is required" }, 400);
  }

  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [recipientEmail],
      subject: "Test email from Memos",
      html: "<p>This is a test email sent from your Memos instance to verify the email configuration.</p>",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return c.json({ error: `Resend API error: ${err}` }, 502);
  }

  return c.json({});
});

// Update instance setting (admin only)
instanceRoutes.patch("/settings/*", authRequired, async (c) => {
  const currentUser = c.get("user");
  if (currentUser.role !== "ADMIN") {
    return c.json({ error: "Admin only" }, 403);
  }

  const fullPath = c.req.path;
  const name = fullPath.replace("/api/v1/instance/settings/", "");
  const key = getInstanceSettingKey(name);
  const body = await c.req.json<{ value: string; description?: string }>();

  const settingsStore = await getSettingsStore(c);

  if (key === "STORAGE") {
    let parsed: any;
    try {
      parsed = JSON.parse(body.value);
    } catch {
      return c.json({ error: "Invalid setting value: not valid JSON" }, 400);
    }
    if (parsed && typeof parsed === "object") {
      const existing = await settingsStore.getInstanceSetting(name);
      let storedS3: any = null;
      try {
        storedS3 = existing ? JSON.parse(existing.value)?.s3Config ?? null : null;
      } catch {
        storedS3 = null;
      }

      // Keep the stored S3 config even when the update omits it (e.g. saving
      // the blob selection) so attachments previously written to S3 stay
      // resolvable after switching backends.
      if (!parsed.s3Config && storedS3) {
        parsed.s3Config = storedS3;
      }
      if (parsed.s3Config && typeof parsed.s3Config === "object") {
        const cfg = parsed.s3Config;
        delete cfg.accessKeySecretSet; // sanitized-view flag, never stored
        // The API never returns the stored secret, so a blank secret means
        // "keep the existing one".
        if (!cfg.accessKeySecret && storedS3?.accessKeySecret) {
          cfg.accessKeySecret = storedS3.accessKeySecret;
        }

        const s3Selected = parsed.storageType === "S3" || Number(parsed.storageType ?? 0) === 3;
        if (s3Selected) {
          const missing: string[] = [];
          if (!cfg.endpoint) missing.push("endpoint");
          if (!cfg.bucket) missing.push("bucket");
          if (!cfg.accessKeyId) missing.push("accessKeyId");
          if (!cfg.accessKeySecret) missing.push("accessKeySecret");
          if (missing.length > 0) {
            return c.json({ error: `Incomplete S3 configuration: missing ${missing.join(", ")}` }, 400);
          }
        }
      }
      body.value = JSON.stringify(parsed);
    }
  }

  await settingsStore.setInstanceSetting(name, body.value, body.description);
  
  const settingCacheKeys =
    key === "AI"
      ? [`instance:setting:${name}:admin`, `instance:setting:${name}:public`]
      : [`instance:setting:${name}`];
  await deleteCachedKeys(c.env.CACHE, [
    "instance:profile",
    "instance:settings",
    ...settingCacheKeys,
  ]);
  return c.json({ name, value: key === "STORAGE" ? sanitizeStorageSettingValue(body.value) : body.value });
});

instanceRoutes.get("/stats", authRequired, async (c) => {
  const currentUser = c.get("user");
  if (currentUser.role !== "ADMIN") {
    return c.json({ error: "Admin only" }, 403);
  }

  const cached = await getCachedJson(c.env.CACHE, "instance:stats");
  if (cached) {
    return c.json(cached);
  }

  const storageRow = await c.env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM attachment").first<{ total: number }>();
  const localStorageBytes = storageRow?.total ?? 0;

  // Blob storage size is not queryable — return -1 to indicate unknown
  const databaseSize = -1;

  const response = {
    database: {
      driver: "edgeone-blob",
      sizeBytes: databaseSize,
    },
    localStorageBytes,
    generatedTime: {
      seconds: Math.floor(Date.now() / 1000),
      nanos: 0,
    },
  };

  await putCachedJson(c.env.CACHE, "instance:stats", response, 60);
  return c.json(response);
});