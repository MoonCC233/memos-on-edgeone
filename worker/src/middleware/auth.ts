import { createMiddleware } from "hono/factory";
import type { Env, UserPayload } from "../types";
import { verifyAccessToken } from "../auth/jwt";
import { hashPAT } from "../auth/pat";
import { createSettingsStore } from "../db/settings-blob";
import { findUserById } from "../db/user";

type AuthEnv = {
  Bindings: Env;
  Variables: { user: UserPayload };
};

type PATLookupResult = {
  user_id: number;
  username: string;
  role: string;
  row_status: string;
};

function extractAuthToken(headers: {
  header: (name: string) => string | undefined;
}): string | undefined {
  const authHeader = headers.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  const xApiKey = headers.header("X-API-Key");
  if (xApiKey) {
    return xApiKey;
  }

  const memosAccessToken = headers.header("Memos-Access-Token");
  if (memosAccessToken) {
    return memosAccessToken;
  }

  const token = headers.header("Token");
  if (token) {
    return token;
  }

  return undefined;
}

async function findUserByPATHash(env: Env, tokenHash: string): Promise<PATLookupResult | null> {
  // PATs live in the blob settings store (written by users.ts via
  // BlobSettingsStore), NOT the legacy user_setting SQL table — so scan the
  // per-user settings files for personal_access_tokens entries.
  const store = await createSettingsStore(env);
  const rows = await store.findUserSettingsByKey("personal_access_tokens");

  for (const row of rows) {
    try {
      const user = await findUserById(env.DB, row.user_id);
      if (!user || user.row_status !== "NORMAL") {
        continue;
      }

      const tokens = JSON.parse(row.value || "[]") as Array<{ hash?: string; expiresAt?: string | null }>;
      const matchedToken = tokens.find((token) => token.hash === tokenHash);
      if (matchedToken) {
        if (matchedToken.expiresAt) {
          const expiresAt = Date.parse(matchedToken.expiresAt);
          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            continue;
          }
        }

        return {
          user_id: user.id,
          username: user.username,
          role: user.role,
          row_status: user.row_status,
        };
      }
    } catch {
      // Ignore malformed PAT payloads and continue scanning.
    }
  }

  return null;
}

export const authRequired = createMiddleware<AuthEnv>(async (c, next) => {
  const token = extractAuthToken(c.req);

  if (!token) {
    return c.json({ code: 16, message: "user not found", details: [] }, 401);
  }

  // Check if it's a PAT
  if (token.startsWith("memos_pat_")) {
    const hash = await hashPAT(token);
    const result = await findUserByPATHash(c.env, hash);

    if (!result) {
      return c.json({ code: 16, message: "invalid access token", details: [] }, 401);
    }

    c.set("user", {
      id: result.user_id,
      username: result.username,
      role: result.role,
      status: result.row_status,
    });
    return next();
  }

  try {
    const claims = await verifyAccessToken(token, c.env.JWT_SECRET);
    c.set("user", {
      id: Number(claims.sub),
      username: claims.name,
      role: claims.role,
      status: claims.status,
    });
    return next();
  } catch {
    return c.json({ code: 16, message: "token has expired", details: [] }, 401);
  }
});

export const authOptional = createMiddleware<AuthEnv>(async (c, next) => {
  const token = extractAuthToken(c.req);

  if (token) {
    if (token.startsWith("memos_pat_")) {
      const hash = await hashPAT(token);
      const result = await findUserByPATHash(c.env, hash);

      if (result) {
        c.set("user", {
          id: result.user_id,
          username: result.username,
          role: result.role,
          status: result.row_status,
        });
      }
    } else {
      try {
        const claims = await verifyAccessToken(token, c.env.JWT_SECRET);
        c.set("user", {
          id: Number(claims.sub),
          username: claims.name,
          role: claims.role,
          status: claims.status,
        });
      } catch {
        // Token invalid, continue without user
      }
    }
  }

  return next();
});
