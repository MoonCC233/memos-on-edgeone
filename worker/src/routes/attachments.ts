import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authOptional, authRequired } from "../middleware/auth";
import { createDirectUploadToken, DIRECT_UPLOAD_TTL_SECONDS, verifyDirectUploadToken } from "../auth/direct-upload";
import * as settingDB from "../db/setting";
import { createErrorBody } from "../error";
import { deleteCachedKeys } from "../cache";
import { StorageProvider } from "../storage";
import { getAttachmentStorage, getAttachmentWriteStorage } from "../storage/resolve";

type AttApp = { Bindings: Env; Variables: { user: UserPayload } };

export const attachmentRoutes = new Hono<AttApp>();

export interface AttachmentRow {
  id: number;
  uid: string;
  creator_id: number;
  created_ts: number;
  updated_ts: number;
  filename: string;
  type: string;
  size: number;
  memo_id: number | null;
  storage_type: string;
  reference: string;
  payload: string;
}

const nowTs = () => Math.floor(Date.now() / 1000);

const generateAttachmentUid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 22);

function formatAttachment(att: AttachmentRow) {
  return {
    id: att.id,
    name: `attachments/${att.uid}`,
    uid: att.uid,
    creatorId: att.creator_id,
    createTime: new Date(att.created_ts * 1000).toISOString(),
    updateTime: new Date(att.updated_ts * 1000).toISOString(),
    filename: att.filename,
    type: att.type,
    size: att.size,
    memoId: att.memo_id,
    storageType: att.storage_type,
    reference: att.reference,
  };
}

function decodeBase64Content(content: string): ArrayBuffer {
  const base64 = content.includes(",") ? content.slice(content.indexOf(",") + 1) : content;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

type MemoTargetResolution = { memoId: number | null } | { error: string; status: 403 | 404 };

async function resolveWritableMemoId(db: D1Database, user: UserPayload, memoName?: string | number | null): Promise<MemoTargetResolution> {
  if (memoName === undefined || memoName === null || memoName === "") {
    return { memoId: null };
  }

  const memoToken = String(memoName);
  const uid = memoToken.startsWith("memos/") ? memoToken.slice("memos/".length) : memoToken;
  const memo = await db.prepare("SELECT id, creator_id FROM memo WHERE uid = ? OR id = ?")
    .bind(uid, Number(uid) || 0)
    .first<{ id: number; creator_id: number }>();
  if (!memo) {
    return { error: "Memo not found", status: 404 };
  }
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return { error: "Permission denied", status: 403 };
  }
  return { memoId: memo.id };
}

async function findAttachmentByToken(db: D1Database, token: string): Promise<AttachmentRow | null> {
  const normalized = token.startsWith("attachments/") ? token.slice("attachments/".length) : token;
  return db.prepare("SELECT * FROM attachment WHERE uid = ? OR id = ?")
    .bind(normalized, Number(normalized) || 0)
    .first<AttachmentRow>();
}

function createPlaceholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function findAttachmentsByTokens(db: D1Database, tokens: string[]): Promise<AttachmentRow[]> {
  const normalizedTokens = [...new Set(tokens.map((token) => token.startsWith("attachments/") ? token.slice("attachments/".length) : token).filter(Boolean))];
  const attachmentsById = new Map<number, AttachmentRow>();
  if (normalizedTokens.length === 0) {
    return [];
  }

  for (const tokenChunk of chunkValues(normalizedTokens, 450)) {
    const numericIds = tokenChunk
      .map((token) => Number(token))
      .filter((id) => Number.isInteger(id) && id > 0);
    const conditions = [`uid IN (${createPlaceholders(tokenChunk.length)})`];
    const params: Array<string | number> = [...tokenChunk];

    if (numericIds.length > 0) {
      conditions.push(`id IN (${createPlaceholders(numericIds.length)})`);
      params.push(...numericIds);
    }

    const { results } = await db.prepare(
      `SELECT * FROM attachment WHERE ${conditions.join(" OR ")}`
    ).bind(...params).all<AttachmentRow>();
    for (const attachment of results) {
      attachmentsById.set(attachment.id, attachment);
    }
  }

  return [...attachmentsById.values()];
}

async function getAttachmentReadDeniedStatus(db: D1Database, att: AttachmentRow, user: UserPayload | undefined): Promise<401 | 403 | undefined> {
  if (!att.memo_id) {
    return user && (att.creator_id === user.id || user.role === "ADMIN") ? undefined : 403;
  }

  const memo = await db.prepare("SELECT visibility, creator_id FROM memo WHERE id = ?")
    .bind(att.memo_id)
    .first<{ visibility: string; creator_id: number }>();
  if (!memo) {
    return user && (att.creator_id === user.id || user.role === "ADMIN") ? undefined : 403;
  }
  if (memo.visibility === "PRIVATE" && (!user || user.id !== memo.creator_id)) {
    return 403;
  }
  if (memo.visibility === "PROTECTED" && !user) {
    return 401;
  }
  return undefined;
}

const DEFAULT_MAX_UPLOAD_SIZE_MB = 100;

const getMaxUploadSizeMb = async (db: any) => {
  const setting = await settingDB.getInstanceSetting(db, "STORAGE");
  if (!setting) {
    return DEFAULT_MAX_UPLOAD_SIZE_MB;
  }
  try {
    const parsed = JSON.parse(setting.value) || {};
    const limit = Number(parsed.uploadSizeLimitMb);
    return limit > 0 ? limit : DEFAULT_MAX_UPLOAD_SIZE_MB;
  } catch {
    return DEFAULT_MAX_UPLOAD_SIZE_MB;
  }
};

// Upload attachment
attachmentRoutes.post("/", authRequired, async (c) => {
  const user = c.get("user");
  const contentType = c.req.header("content-type") || "";
  const maxUploadSizeMb = await getMaxUploadSizeMb(c.env.DB);
  const maxUploadSize = maxUploadSizeMb * 1024 * 1024;

  let filename: string;
  let fileType: string;
  let fileData: ArrayBuffer;
  let memoId: number | null = null;

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = (formData.get("file") || formData.get("attachment") || formData.get("content")) as File | null;
    if (!file) return c.json({ error: "No file provided" }, 400);
    if (file.size > maxUploadSize) {
      return c.json(
        createErrorBody(`File too large. Maximum upload size is ${maxUploadSizeMb}MB.`, {
          errorKey: "message.maximum-upload-size-is",
          errorParams: { size: maxUploadSizeMb },
        }),
        413,
      );
    }
    filename = file.name;
    fileType = file.type;
    fileData = await file.arrayBuffer();
    const resolvedMemo = await resolveWritableMemoId(c.env.DB, user, formData.get("memo")?.toString() || null);
    if ("error" in resolvedMemo) return c.json({ error: resolvedMemo.error }, resolvedMemo.status);
    memoId = resolvedMemo.memoId;
  } else {
    const body = await c.req.json();
    const attachment = body.attachment || body;
    filename = attachment.filename || "unnamed";
    fileType = attachment.type || "application/octet-stream";
    const resolvedMemo = await resolveWritableMemoId(c.env.DB, user, attachment.memo);
    if ("error" in resolvedMemo) return c.json({ error: resolvedMemo.error }, resolvedMemo.status);
    memoId = resolvedMemo.memoId;

    if (attachment.content) {
      fileData = decodeBase64Content(attachment.content);
      if (fileData.byteLength > maxUploadSize) {
        return c.json(
          createErrorBody(`File too large. Maximum upload size is ${maxUploadSizeMb}MB.`, {
            errorKey: "message.maximum-upload-size-is",
            errorParams: { size: maxUploadSizeMb },
          }),
          413,
        );
      }
    } else {
      return c.json({ error: "No content provided" }, 400);
    }
  }

  const uid = generateAttachmentUid();
  const storageKey = `attachments/${uid}/${filename}`;

  // Store in the configured attachment storage (EdgeOne Blob by default,
  // S3-compatible bucket when selected in 设置 → 存储) and record which
  // backend was used so reads/deletes can resolve it later.
  const { storage, storageType } = await getAttachmentWriteStorage(c.env);
  await storage.put(storageKey, fileData, { contentType: fileType });

  // Store metadata in database
  const createdTs = nowTs();
  const att = await c.env.DB.prepare(
    `INSERT INTO attachment (uid, creator_id, created_ts, updated_ts, filename, type, size, memo_id, storage_type, reference)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  )
    .bind(uid, user.id, createdTs, createdTs, filename, fileType, fileData.byteLength, memoId, storageType, storageKey)
    .first<AttachmentRow>();

  await deleteCachedKeys(c.env.CACHE, ["instance:stats"]);
  return c.json(formatAttachment(att!), 201);
});

// Issue a presigned URL so a large file can be PUT straight to storage.
//
// EdgeOne Pages Cloud Functions cap the request body at 6 MB: anything bigger
// is rejected by the platform with an HTML error page before this worker ever
// runs, so files above MULTIPART_MAX_BYTES (see web/src/api/direct-upload.ts)
// must not travel through the function. The bytes go client → storage, and
// only the ticket (this call) and the finalize call below go through the
// function, both of them tiny.
attachmentRoutes.post("/upload-url", authRequired, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    filename?: string;
    type?: string;
    size?: number;
    memo?: string | number | null;
  }>();

  const filename = typeof body.filename === "string" && body.filename ? body.filename : "unnamed";
  const fileType = typeof body.type === "string" && body.type ? body.type : "application/octet-stream";
  const fileSize = Math.floor(Number(body.size));
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return c.json({ error: "Invalid file size" }, 400);
  }

  const maxUploadSizeMb = await getMaxUploadSizeMb(c.env.DB);
  if (fileSize > maxUploadSizeMb * 1024 * 1024) {
    return c.json(
      createErrorBody(`File too large. Maximum upload size is ${maxUploadSizeMb}MB.`, {
        errorKey: "message.maximum-upload-size-is",
        errorParams: { size: maxUploadSizeMb },
      }),
      413,
    );
  }

  // Validate the memo target now so we fail before the browser starts
  // uploading bytes.
  const resolvedMemo = await resolveWritableMemoId(c.env.DB, user, body.memo ?? null);
  if ("error" in resolvedMemo) return c.json({ error: resolvedMemo.error }, resolvedMemo.status);

  const uid = generateAttachmentUid();
  const storageKey = `attachments/${uid}/${filename}`;
  const { storage, storageType } = await getAttachmentWriteStorage(c.env);

  let presignedUrl: string;
  try {
    const upload = await storage.createUploadUrl(storageKey, {
      expireSeconds: DIRECT_UPLOAD_TTL_SECONDS,
      contentType: fileType,
    });
    presignedUrl = upload.url;
  } catch (error) {
    return c.json(
      {
        error: `Direct upload unavailable: ${
          error instanceof Error ? error.message : "could not sign the upload URL"
        }`,
      },
      500,
    );
  }

  const { token, expiresAt } = await createDirectUploadToken(c.env.JWT_SECRET, user.id, {
    key: storageKey,
    uid,
    filename,
    type: fileType,
    size: fileSize,
    storageType,
  });

  return c.json({ url: presignedUrl, key: storageKey, expiresAt, token });
});

// Finalize a direct upload: verify the object actually reached storage, then
// create the attachment row. Idempotent on the storage key so a dropped
// response can be retried without duplicating the attachment.
attachmentRoutes.post("/complete", authRequired, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ token?: string; memo?: string | number | null }>();

  if (typeof body.token !== "string" || !body.token) {
    return c.json({ error: "Missing upload token" }, 400);
  }
  const claims = await verifyDirectUploadToken(body.token, c.env.JWT_SECRET, user.id);
  if (!claims) {
    return c.json({ error: "Invalid or expired upload token" }, 400);
  }

  const existing = await c.env.DB.prepare("SELECT * FROM attachment WHERE reference = ?")
    .bind(claims.key)
    .first<AttachmentRow>();
  if (existing) return c.json(formatAttachment(existing));

  const storage: StorageProvider = await getAttachmentStorage(c.env, claims.storageType);
  let uploaded = await storage.exists(claims.key);
  if (!uploaded) {
    // Some backends may briefly lag the browser's PUT.
    await new Promise((resolve) => setTimeout(resolve, 250));
    uploaded = await storage.exists(claims.key);
  }
  if (!uploaded) {
    return c.json({ error: "Uploaded file not found in storage" }, 409);
  }

  const resolvedMemo = await resolveWritableMemoId(c.env.DB, user, body.memo ?? null);
  if ("error" in resolvedMemo) return c.json({ error: resolvedMemo.error }, resolvedMemo.status);

  const createdTs = nowTs();
  const att = await c.env.DB.prepare(
    `INSERT INTO attachment (uid, creator_id, created_ts, updated_ts, filename, type, size, memo_id, storage_type, reference)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  )
    .bind(
      claims.uid,
      user.id,
      createdTs,
      createdTs,
      claims.filename,
      claims.type,
      claims.size,
      resolvedMemo.memoId,
      claims.storageType,
      claims.key,
    )
    .first<AttachmentRow>();

  await deleteCachedKeys(c.env.CACHE, ["instance:stats"]);
  return c.json(formatAttachment(att!), 201);
});

// List attachments
attachmentRoutes.get("/", authRequired, async (c) => {
  const user = c.get("user");
  const pageSize = Math.min(Number(c.req.query("pageSize")) || 50, 1000);
  const pageToken = c.req.query("pageToken");
  const filter = c.req.query("filter") || "";
  let offset = 0;
  if (pageToken) {
    try { offset = Number(atob(pageToken)); } catch {}
  }

  const whereConditions = ["creator_id = ?"];
  const params: (string | number | null)[] = [user.id];

  if (filter.includes("memo_id == null") || filter.includes("memo == null")) {
    whereConditions.push("memo_id IS NULL");
  }

  const whereClause = `WHERE ${whereConditions.join(" AND ")}`;

  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM attachment ${whereClause}`
  ).bind(...params).first<{ total: number }>();
  const total = countResult?.total ?? 0;

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM attachment ${whereClause} ORDER BY created_ts DESC LIMIT ? OFFSET ?`
  ).bind(...params, pageSize, offset).all<AttachmentRow>();

  const nextPageToken = offset + pageSize < total ? btoa(String(offset + pageSize)) : "";

  return c.json({
    attachments: results.map(formatAttachment),
    nextPageToken,
    totalSize: total,
  });
});

// Get attachment
attachmentRoutes.get("/:id", authOptional, async (c) => {
  const att = await findAttachmentByToken(c.env.DB, c.req.param("id"));
  if (!att) return c.json({ error: "Not found" }, 404);
  const deniedStatus = await getAttachmentReadDeniedStatus(c.env.DB, att, c.get("user"));
  if (deniedStatus) {
    return c.json({ error: deniedStatus === 401 ? "Authentication required" : "Permission denied" }, deniedStatus);
  }
  return c.json(formatAttachment(att));
});

// Update attachment
attachmentRoutes.patch("/:id", authRequired, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ filename?: string; memoId?: number | null; memo?: string | null }>();

  const att = await findAttachmentByToken(c.env.DB, c.req.param("id"));
  if (!att) return c.json({ error: "Not found" }, 404);
  if (att.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (body.filename !== undefined) { updates.push("filename = ?"); params.push(body.filename); }
  if (body.memoId !== undefined || body.memo !== undefined) {
    const resolvedMemo = await resolveWritableMemoId(c.env.DB, user, body.memo ?? body.memoId ?? null);
    if ("error" in resolvedMemo) return c.json({ error: resolvedMemo.error }, resolvedMemo.status);
    updates.push("memo_id = ?");
    params.push(resolvedMemo.memoId);
  }

  if (updates.length > 0) {
    updates.push("updated_ts = strftime('%s', 'now')");
    params.push(att.id);
    await c.env.DB.prepare(`UPDATE attachment SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...params).run();
  }

  const updated = await c.env.DB.prepare("SELECT * FROM attachment WHERE id = ?")
    .bind(att.id).first<AttachmentRow>();
  return c.json(formatAttachment(updated!));
});

// Delete attachment
attachmentRoutes.delete("/:id", authRequired, async (c) => {
  const user = c.get("user");

  const att = await findAttachmentByToken(c.env.DB, c.req.param("id"));
  if (!att) return c.json({ error: "Not found" }, 404);
  if (att.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  // Delete from the backend this attachment was stored in
  if (att.reference) {
    const storage: StorageProvider = await getAttachmentStorage(c.env, att.storage_type);
    await storage.delete(att.reference);
  }

  await c.env.DB.prepare("DELETE FROM attachment WHERE id = ?").bind(att.id).run();
  await deleteCachedKeys(c.env.CACHE, ["instance:stats"]);
  return c.json({});
});

// Batch delete
attachmentRoutes.post("/batchDelete", authRequired, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ ids?: Array<number | string>; names?: string[] }>();

  const attachments = await findAttachmentsByTokens(c.env.DB, (body.names || body.ids || []).map(String));
  const deletableAttachments = attachments.filter((att) => att.creator_id === user.id || user.role === "ADMIN");

  await Promise.all(
    deletableAttachments.map(async (att) => {
      if (!att.reference) return;
      const storage: StorageProvider = await getAttachmentStorage(c.env, att.storage_type);
      await storage.delete(att.reference);
    })
  );

  const attachmentIds = deletableAttachments.map((att) => att.id);
  for (const chunk of chunkValues(attachmentIds, 900)) {
    await c.env.DB.prepare(
      `DELETE FROM attachment WHERE id IN (${createPlaceholders(chunk.length)})`
    ).bind(...chunk).run();
  }

  await deleteCachedKeys(c.env.CACHE, ["instance:stats"]);
  return c.json({});
});