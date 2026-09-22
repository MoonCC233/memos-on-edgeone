import { Hono } from "hono";
import {
  buildIdentityProviderName,
  extractIdentityProviderUid,
  normalizeIdentityProviderType,
  normalizeStoredOAuth2Config,
  serializeIdentityProvider,
  type IdpRow,
} from "../idp";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";

type IdpApp = { Bindings: Env; Variables: { user: UserPayload } };

export const idpRoutes = new Hono<IdpApp>();

idpRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM idp ORDER BY id ASC").all<IdpRow>();
  return c.json({ identityProviders: (results || []).map((row) => serializeIdentityProvider(row)) });
});

idpRoutes.post("/", authRequired, async (c) => {
  const user = c.get("user");
  if (user.role !== "ADMIN") return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  const requestedId = extractIdentityProviderUid(body.identityProviderId || body.name);
  const uid = requestedId || crypto.randomUUID().replace(/-/g, "").slice(0, 22);
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : uid;
  const type = normalizeIdentityProviderType(body.type);
  const identifierFilter = body.identifierFilter || body.identifier_filter || "";
  const config = normalizeStoredOAuth2Config(body.config);
  const result = await c.env.DB.prepare(
    "INSERT INTO idp (uid, name, type, identifier_filter, config) VALUES (?, ?, ?, ?, ?) RETURNING *"
  )
    .bind(uid, title, type, identifierFilter, JSON.stringify(config))
    .first<IdpRow>();

  return c.json(
    serializeIdentityProvider(
      result || {
        uid,
        name: title,
        type,
        identifier_filter: identifierFilter,
        config: JSON.stringify(config),
      },
    ),
    201,
  );
});

idpRoutes.patch("/:id", authRequired, async (c) => {
  const user = c.get("user");
  if (user.role !== "ADMIN") return c.json({ error: "Admin only" }, 403);

  const id = extractIdentityProviderUid(c.req.param("id"));
  const body = await c.req.json();
  const updates: string[] = [];
  const params: unknown[] = [];

  const title =
    typeof body.title === "string"
      ? body.title.trim()
      : typeof body.name === "string" && !body.name.startsWith(buildIdentityProviderName(""))
        ? body.name.trim()
        : undefined;
  if (title !== undefined) {
    updates.push("name = ?");
    params.push(title);
  }
  if (body.type !== undefined) {
    updates.push("type = ?");
    params.push(normalizeIdentityProviderType(body.type));
  }
  if (body.identifierFilter !== undefined || body.identifier_filter !== undefined) {
    updates.push("identifier_filter = ?");
    params.push(body.identifierFilter ?? body.identifier_filter ?? "");
  }
  if (body.config !== undefined) {
    const existing = await c.env.DB.prepare("SELECT * FROM idp WHERE id = ? OR uid = ?").bind(id, id).first<IdpRow>();
    const nextConfig = normalizeStoredOAuth2Config(body.config);
    if (nextConfig.clientSecret === "" && existing) {
      const existingConfig = normalizeStoredOAuth2Config(existing.config);
      nextConfig.clientSecret = existingConfig.clientSecret;
    }
    updates.push("config = ?");
    params.push(JSON.stringify(nextConfig));
  }

  if (updates.length > 0) {
    params.push(id);
    await c.env.DB.prepare(`UPDATE idp SET ${updates.join(", ")} WHERE id = ? OR uid = ?`).bind(...params, id).run();
  }

  const result = await c.env.DB.prepare("SELECT * FROM idp WHERE id = ? OR uid = ?").bind(id, id).first<IdpRow>();
  if (!result) {
    return c.json({ error: "Identity provider not found" }, 404);
  }
  return c.json(serializeIdentityProvider(result));
});

idpRoutes.delete("/:id", authRequired, async (c) => {
  const user = c.get("user");
  if (user.role !== "ADMIN") return c.json({ error: "Admin only" }, 403);

  const id = extractIdentityProviderUid(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM idp WHERE id = ? OR uid = ?").bind(id, id).run();
  return c.json({});
});
