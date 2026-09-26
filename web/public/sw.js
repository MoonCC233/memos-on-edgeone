/**
 * Attachment file worker.
 *
 * EdgeOne Pages Cloud Functions cap request AND response bodies at 6 MB, so a
 * larger /file/ response never reaches the browser: the platform answers with
 * an HTML 500 page instead (the same limit that used to break large uploads).
 *
 * Everything is passed straight through — this worker adds no caching and no
 * interception for anything except GET /file/... That one path is retried with
 * ranged sub-requests when the platform's error page (or a network failure)
 * comes back, and the chunks are stitched into a single response, so
 * attachments larger than the limit still display and download.
 *
 * Register it from the app (see web/src/main.tsx).
 */

const FILE_PATH_PREFIX = "/file/";
const CHUNK_BYTES = 4 * 1024 * 1024; // stay comfortably below the 6 MB cap

function isPlatformErrorPage(response) {
  // Our own worker only ever answers with JSON, so an HTML 5xx is the
  // platform's replacement response — most often the body-size cap.
  if (response.status < 500) return false;
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("text/html");
}

/**
 * Parse a single-range `Range` header against a known total size.
 * Returns { start, end } (inclusive) or null when unsupported/invalid, which
 * callers treat as "give up and show the original error".
 */
function parseRange(header, total) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const rawStart = match[1];
  const rawEnd = match[2];
  if (!rawStart && !rawEnd) return null;

  let start;
  let end;
  if (!rawStart) {
    // Suffix range: `bytes=-500` → last 500 bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(total - suffix, 0);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : total - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start >= total || end < start) return null;
  return { start, end: Math.min(end, total - 1) };
}

/**
 * Rebuild the request with a Range header. Built from the URL rather than
 * from the original Request on purpose: navigation requests (opening a file
 * URL directly) carry mode "navigate", which cannot be cloned.
 */
function rangedRequest(request, rangeValue) {
  const headers = new Headers(request.headers);
  headers.set("Range", rangeValue);
  return new Request(request.url, {
    method: "GET",
    headers,
    credentials: request.credentials,
    mode: "same-origin",
    redirect: "follow",
  });
}

/**
 * Fetch `request` in CHUNK_BYTES ranged pieces and return one assembled
 * response (200 for an unqualified request, 206 when the original carried a
 * Range header).
 */
async function stitchWithRanges(request) {
  const probe = await fetch(rangedRequest(request, "bytes=0-0"));
  if (probe.status !== 206) {
    throw new Error(`range probe returned ${probe.status}`);
  }
  const contentRange = probe.headers.get("content-range") || "";
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
  if (!match) throw new Error("range probe response has no usable Content-Range");
  const total = Number(match[3]);
  if (!Number.isFinite(total) || total <= 0) throw new Error("range probe reported an invalid total size");
  // Drain the 1-byte probe body so the connection is released.
  await probe.arrayBuffer().catch(() => undefined);

  let start = 0;
  let end = total - 1;
  const requestedRange = request.headers.get("Range");
  if (requestedRange) {
    const parsed = parseRange(requestedRange, total);
    if (!parsed) throw new Error("unsupported Range request");
    start = parsed.start;
    end = parsed.end;
  }

  const contentType = probe.headers.get("content-type") || "application/octet-stream";
  const cacheControl = probe.headers.get("cache-control");
  const parts = [];
  for (let offset = start; offset <= end; offset += CHUNK_BYTES) {
    const chunkEnd = Math.min(offset + CHUNK_BYTES - 1, end);
    const chunk = await fetch(rangedRequest(request, `bytes=${offset}-${chunkEnd}`));
    if (chunk.status !== 206) throw new Error(`range chunk returned ${chunk.status}`);
    parts.push(await chunk.blob());
  }

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Accept-Ranges", "bytes");
  if (cacheControl) headers.set("Cache-Control", cacheControl);
  const body = new Blob(parts, { type: contentType });
  if (requestedRange) {
    headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
    return new Response(body, { status: 206, headers });
  }
  return new Response(body, { status: 200, headers });
}

async function handleFileRequest(request) {
  let response = null;
  try {
    response = await fetch(request);
  } catch {
    response = null;
  }
  // Anything that isn't the platform's oversized-body page passes through
  // untouched (our own JSON errors, 403/404, small files, …).
  if (response && !isPlatformErrorPage(response)) return response;
  try {
    return await stitchWithRanges(request);
  } catch {
    // Stitching failed too — surface the original error rather than a blank.
    return response || new Response("Failed to load file", { status: 502 });
  }
}

const isServiceWorkerScope =
  typeof ServiceWorkerGlobalScope !== "undefined" &&
  typeof self !== "undefined" &&
  self instanceof ServiceWorkerGlobalScope;

if (isServiceWorkerScope) {
  self.addEventListener("install", (event) => {
    event.waitUntil(self.skipWaiting());
  });
  self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
  });
  self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (!url.pathname.startsWith(FILE_PATH_PREFIX)) return;
    event.respondWith(handleFileRequest(request));
  });
}

// Exposed so the unit tests can reach the internals of this classic script.
globalThis.__fileServiceWorker = {
  CHUNK_BYTES,
  FILE_PATH_PREFIX,
  isPlatformErrorPage,
  parseRange,
  stitchWithRanges,
  handleFileRequest,
};
