/**
 * Signed tickets for the direct-upload flow.
 *
 * EdgeOne Pages Cloud Functions reject any request whose body exceeds 6 MB —
 * the platform answers with an HTML error page before our route code runs, so
 * large attachments cannot travel through the function at all. Instead the
 * browser PUTs the bytes straight to storage with a presigned URL and then
 * calls `POST /api/v1/attachments/complete` carrying a ticket like this one,
 * which lets the worker verify exactly what was uploaded (and by whom) before
 * it creates the attachment row.
 */
import { SignJWT, jwtVerify } from "jose";
import { getSecretKey } from "./jwt";

const ISSUER = "memos";
const DIRECT_UPLOAD_AUD = "user.direct-upload-token";

/** Tickets only need to outlive the browser's single PUT. */
export const DIRECT_UPLOAD_TTL_SECONDS = 15 * 60;

export interface DirectUploadClaims {
  /** Storage object key the ticket is bound to. */
  key: string;
  uid: string;
  filename: string;
  type: string;
  size: number;
  storageType: "BLOB" | "S3";
}

export async function createDirectUploadToken(
  secret: string,
  userId: number,
  claims: DirectUploadClaims
): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + DIRECT_UPLOAD_TTL_SECONDS;

  const token = await new SignJWT({
    key: claims.key,
    uid: claims.uid,
    filename: claims.filename,
    type: claims.type,
    size: claims.size,
    storageType: claims.storageType,
  })
    .setProtectedHeader({ alg: "HS256", kid: "v1" })
    .setSubject(String(userId))
    .setIssuer(ISSUER)
    .setAudience(DIRECT_UPLOAD_AUD)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(getSecretKey(secret));

  return { token, expiresAt };
}

/**
 * Verifies a ticket and returns its claims, or null when the ticket is
 * invalid, expired, issued to another user, or references something outside
 * the attachments prefix.
 */
export async function verifyDirectUploadToken(
  token: string,
  secret: string,
  userId: number
): Promise<DirectUploadClaims | null> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, getSecretKey(secret), {
      issuer: ISSUER,
      audience: DIRECT_UPLOAD_AUD,
    }));
  } catch {
    return null;
  }

  if (Number(payload.sub) !== userId) return null;

  const key = typeof payload.key === "string" ? payload.key : "";
  const uid = typeof payload.uid === "string" ? payload.uid : "";
  const filename = typeof payload.filename === "string" ? payload.filename : "";
  const type = typeof payload.type === "string" ? payload.type : "";
  const size = typeof payload.size === "number" ? payload.size : 0;
  const storageType = payload.storageType === "S3" ? "S3" : "BLOB";

  if (!key.startsWith("attachments/") || !uid || !filename || !Number.isFinite(size) || size <= 0) {
    return null;
  }

  return { key, uid, filename, type, size, storageType };
}
