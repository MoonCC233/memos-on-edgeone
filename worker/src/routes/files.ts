import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Env, UserPayload } from "../types";
import { authOptional } from "../middleware/auth";
import { verifyRefreshToken } from "../auth/jwt";
import * as shareDB from "../db/share";
import { StorageProvider, GetObjectResult } from "../storage";
import { getAttachmentStorage } from "../storage/resolve";

type FileApp = { Bindings: Env; Variables: { user: UserPayload } };

export const fileRoutes = new Hono<FileApp>();

const UNSAFE_MIME_TYPES = new Set([
  "text/html",
  "text/xml",
  "image/svg+xml",
  "application/xhtml+xml",
]);

function parseRangeHeader(rangeHeader: string | undefined, totalSize: number) {
  if (!rangeHeader || totalSize <= 0) {
    return undefined;
  }

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return undefined;
  }

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return undefined;
  }

  let start: number;
  let end: number;

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return undefined;
    }
    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : totalSize - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= totalSize) {
    return undefined;
  }

  end = Math.min(end, totalSize - 1);
  return { start, end, length: end - start + 1 };
}

const resolveUserFromRequest = async (c: { req: { header: (name: string) => string | undefined }; env: Env; get: (key: "user") => UserPayload | undefined }) => {
  const existingUser = c.get("user");
  if (existingUser) {
    return existingUser;
  }

  const refreshToken = getCookie(c as any, "memos_refresh");
  if (!refreshToken) {
    return undefined;
  }

  try {
    const claims = await verifyRefreshToken(refreshToken, c.env.JWT_SECRET);
    return {
      id: Number(claims.sub),
      username: claims.name,
      role: claims.role,
      status: claims.status,
    };
  } catch {
    return undefined;
  }
};

async function hasValidShareTokenForAttachment(db: any, token: string | undefined, memoId: number | null) {
  if (!token || !memoId) {
    return false;
  }

  const share = await shareDB.getShareByUid(db, token);
  if (!share || share.memo_id !== memoId) {
    return false;
  }

  return !share.expires_ts || share.expires_ts >= Math.floor(Date.now() / 1000);
}

// Serve attachment file
fileRoutes.get("/attachments/:uid/:filename", authOptional, async (c) => {
  const uid = c.req.param("uid");
  const filename = c.req.param("filename");

  const att = await c.env.DB.prepare(
    "SELECT * FROM attachment WHERE uid = ?"
  ).bind(uid).first<{ id: number; creator_id: number; type: string; size: number; reference: string; memo_id: number | null; filename: string; storage_type: string }>();

  if (!att) return c.notFound();

  let cacheControl = "private, no-store";
  const hasShareAccess = await hasValidShareTokenForAttachment(c.env.DB, c.req.query("share_token") || c.req.query("shareToken"), att.memo_id);

  // Check visibility via memo
  if (att.memo_id) {
    const memo = await c.env.DB.prepare(
      "SELECT visibility, creator_id FROM memo WHERE id = ?"
    ).bind(att.memo_id).first<{ visibility: string; creator_id: number }>();

    if (memo) {
      if (!hasShareAccess) {
        const user = await resolveUserFromRequest(c);
        if (memo.visibility === "PRIVATE" && (!user || user.id !== memo.creator_id)) {
          return c.json({ error: "Permission denied" }, 403);
        }
        if (memo.visibility === "PROTECTED" && !user) {
          return c.json({ error: "Authentication required" }, 401);
        }
        if (memo.visibility === "PUBLIC") {
          cacheControl = "public, max-age=31536000, immutable";
        } else if (user?.id === memo.creator_id) {
          cacheControl = "private, max-age=300";
        }
      }
    } else {
      const user = await resolveUserFromRequest(c);
      if (!user || (user.id !== att.creator_id && user.role !== "ADMIN")) {
        return c.json({ error: "Permission denied" }, 403);
      }
    }
  } else {
    const user = await resolveUserFromRequest(c);
    if (!user || (user.id !== att.creator_id && user.role !== "ADMIN")) {
      return c.json({ error: "Permission denied" }, 403);
    }
  }

  const range = parseRangeHeader(c.req.header("Range"), att.size);
  const storage: StorageProvider = await getAttachmentStorage(c.env, att.storage_type);
  
  const getResult: GetObjectResult | null = range
    ? await storage.get(att.reference, { range: { offset: range.start, length: range.length } })
    : await storage.get(att.reference);
    
  if (!getResult || !getResult.body) {
    return c.notFound();
  }

  let contentType = att.type || "application/octet-stream";
  if (UNSAFE_MIME_TYPES.has(contentType)) {
    contentType = "application/octet-stream";
  }

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes",
  };

  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${att.size}`;
    headers["Content-Length"] = String(range.length);
    return new Response(getResult.body, { status: 206, headers });
  }

  if (getResult.contentLength) {
    headers["Content-Length"] = String(getResult.contentLength);
  }

  return new Response(getResult.body, { status: 200, headers });
});

// Serve user avatar
fileRoutes.get("/users/:identifier/avatar", async (c) => {
  const identifier = c.req.param("identifier");

  const user = await c.env.DB.prepare(
    "SELECT avatar_url FROM user WHERE username = ? OR id = ?"
  ).bind(identifier, Number(identifier) || 0).first<{ avatar_url: string }>();

  if (!user || !user.avatar_url) {
    // Return default avatar SVG
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="50" fill="#e2e8f0"/>
      <circle cx="50" cy="35" r="18" fill="#94a3b8"/>
      <ellipse cx="50" cy="85" rx="30" ry="25" fill="#94a3b8"/>
    </svg>`;
    return new Response(svg, {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" },
    });
  }

  // If avatar is a Blob storage reference
  if (user.avatar_url.startsWith("avatars/")) {
    const storage: StorageProvider = c.env.BUCKET;
    const getResult = await storage.get(user.avatar_url);
    if (getResult && getResult.body) {
      return new Response(getResult.body, {
        headers: {
          "Content-Type": getResult.contentType || "image/png",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }
  }

  // Redirect to external URL
  return Response.redirect(user.avatar_url, 302);
});