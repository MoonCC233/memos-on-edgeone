import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";
import * as settingDB from "../db/setting";
import { buildMemoFilterWhere, MemoFilterError } from "../filter/memo-filter";

type ShortcutApp = { Bindings: Env; Variables: { user: UserPayload } };

export const shortcutRoutes = new Hono<ShortcutApp>();

interface ShortcutRecord {
  id: string;
  name: string;
  title: string;
  filter: string;
}

function createShortcutId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

function getShortcutIdFromName(name: unknown): string | undefined {
  if (typeof name !== "string") {
    return undefined;
  }
  const parts = name.split("/");
  const index = parts.lastIndexOf("shortcuts");
  return index >= 0 ? parts[index + 1] || undefined : undefined;
}

function buildShortcutName(username: string, id: string): string {
  return `users/${username}/shortcuts/${id}`;
}

function normalizeShortcut(value: unknown, user: UserPayload): ShortcutRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const id = getShortcutIdFromName(raw.name) || (typeof raw.id === "string" ? raw.id : undefined);
  if (!id) {
    return undefined;
  }
  return {
    id,
    name: buildShortcutName(user.username, id),
    title: typeof raw.title === "string" ? raw.title : "",
    filter: typeof raw.filter === "string" ? raw.filter : "",
  };
}

async function loadShortcuts(db: D1Database, user: UserPayload): Promise<ShortcutRecord[]> {
  const setting = await settingDB.getUserSetting(db, user.id, "shortcuts");
  if (!setting) {
    return [];
  }

  try {
    const parsed = JSON.parse(setting.value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item) => {
      const shortcut = normalizeShortcut(item, user);
      return shortcut ? [shortcut] : [];
    });
  } catch {
    return [];
  }
}

async function saveShortcuts(db: D1Database, user: UserPayload, shortcuts: ShortcutRecord[]) {
  await settingDB.setUserSetting(
    db,
    user.id,
    "shortcuts",
    JSON.stringify(
      shortcuts.map((shortcut) => ({
        id: shortcut.id,
        name: buildShortcutName(user.username, shortcut.id),
        title: shortcut.title,
        filter: shortcut.filter,
      })),
    ),
  );
}

async function validateShortcutFilter(db: D1Database, filter: string): Promise<string | undefined> {
  try {
    await buildMemoFilterWhere(db, filter);
    return undefined;
  } catch (error) {
    return error instanceof MemoFilterError ? error.message : "Invalid shortcut filter";
  }
}

shortcutRoutes.get("/", authRequired, async (c) => {
  const user = c.get("user");
  const shortcuts = await loadShortcuts(c.env.DB, user);
  return c.json({ shortcuts });
});

shortcutRoutes.post("/", authRequired, async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const filter = typeof body.filter === "string" ? body.filter.trim() : "";

  if (!title || !filter) {
    return c.json({ error: "Title and filter are required" }, 400);
  }
  const validationError = await validateShortcutFilter(c.env.DB, filter);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  const shortcuts = await loadShortcuts(c.env.DB, user);
  const id = createShortcutId();

  const newShortcut = {
    id,
    name: buildShortcutName(user.username, id),
    title,
    filter,
  };
  shortcuts.push(newShortcut);

  await saveShortcuts(c.env.DB, user, shortcuts);
  return c.json(newShortcut, 201);
});

shortcutRoutes.patch("/:id", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json();

  const shortcuts = await loadShortcuts(c.env.DB, user);

  const idx = shortcuts.findIndex((s) => s.id === id || getShortcutIdFromName(s.name) === id);
  if (idx === -1) return c.json({ error: "Not found" }, 404);

  const title = body.title !== undefined ? String(body.title).trim() : shortcuts[idx].title;
  const filter = body.filter !== undefined ? String(body.filter).trim() : shortcuts[idx].filter;
  if (!title || !filter) {
    return c.json({ error: "Title and filter are required" }, 400);
  }
  const validationError = await validateShortcutFilter(c.env.DB, filter);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  shortcuts[idx] = {
    id: shortcuts[idx].id,
    name: buildShortcutName(user.username, shortcuts[idx].id),
    title,
    filter,
  };
  await saveShortcuts(c.env.DB, user, shortcuts);
  return c.json(shortcuts[idx]);
});

shortcutRoutes.delete("/:id", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  const shortcuts = await loadShortcuts(c.env.DB, user);

  const filtered = shortcuts.filter((s) => s.id !== id && getShortcutIdFromName(s.name) !== id);
  if (filtered.length === shortcuts.length) {
    return c.json({ error: "Not found" }, 404);
  }
  await saveShortcuts(c.env.DB, user, filtered);
  return c.json({});
});
