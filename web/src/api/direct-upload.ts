import { apiRequest } from "./client";

/**
 * Files at or below this size still travel through the regular multipart
 * endpoint. Anything larger bypasses the function entirely.
 *
 * EdgeOne Pages Cloud Functions cap the request body at 6 MB — the platform
 * answers with an HTML error page before our worker ever runs, which is what
 * produced the old "Failed to save memo: Internal Error" toast. For larger
 * files the browser asks the worker for a presigned URL, PUTs the bytes
 * straight to storage (client → storage, no function in the path) and then
 * finalizes the upload with a small JSON call.
 */
export const MULTIPART_MAX_BYTES = 5 * 1024 * 1024;

interface UploadSession {
  url: string;
  key: string;
  expiresAt: number;
  token: string;
}

export interface DirectUploadOptions {
  filename: string;
  type: string;
  memo?: string | null;
}

/**
 * Upload a file by handing its bytes straight to storage via a presigned PUT
 * URL, then create the attachment row with the returned upload ticket.
 *
 * Returns the raw attachment payload (same shape as POST /api/v1/attachments).
 */
export async function uploadFileDirectly(file: Blob, options: DirectUploadOptions): Promise<any> {
  // The signature binds this exact Content-Type, so both sides must agree.
  const type = options.type || "application/octet-stream";

  const session = await apiRequest<UploadSession>("POST", "/api/v1/attachments/upload-url", {
    filename: options.filename,
    type,
    size: file.size,
    memo: options.memo ?? null,
  });

  let resp: Response;
  try {
    resp = await fetch(session.url, {
      method: "PUT",
      headers: { "Content-Type": type },
      body: file,
      // The presigned URL is self-authenticating; no cookies needed.
      credentials: "omit",
    });
  } catch (error) {
    throw new Error(
      `Direct upload failed: ${
        error instanceof Error ? error.message : "the storage endpoint could not be reached"
      }`,
    );
  }
  if (!resp.ok) {
    throw new Error(
      `Direct upload failed with HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ""}`,
    );
  }

  return apiRequest("POST", "/api/v1/attachments/complete", {
    token: session.token,
    memo: options.memo ?? null,
  });
}
