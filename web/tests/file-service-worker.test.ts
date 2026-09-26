// @vitest-environment node
/**
 * Unit tests for public/sw.js — the worker that stitches >6 MB attachment
 * responses back together from ranged chunks after the platform's 6 MB
 * function limit replaces them with an HTML 500 page.
 *
 * Runs in the node environment: the worker only needs fetch/Request/Response
 * primitives (no DOM), and the node environment gives it native web APIs —
 * jsdom's Blob does not interop with the Response body stream.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import "../public/sw.js";

const sw = (globalThis as { __fileServiceWorker?: SwHelpers }).__fileServiceWorker as SwHelpers;

interface SwHelpers {
  CHUNK_BYTES: number;
  FILE_PATH_PREFIX: string;
  isPlatformErrorPage: (response: Response) => boolean;
  parseRange: (header: string, total: number) => { start: number; end: number } | null;
  stitchWithRanges: (request: Request) => Promise<Response>;
  handleFileRequest: (request: Request) => Promise<Response>;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const FILE_URL = "https://example.com/file/attachments/xyz/big.png";

function makeBody(total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  for (let i = 0; i < total; i++) bytes[i] = i % 251;
  return bytes;
}

/**
 * fetch mock that serves ranged reads of `bytes`, plus an unqualified-request
 * response from `plainResponse` (used to simulate the platform error page).
 */
function rangedFetch(bytes: Uint8Array, plainResponse: () => Response) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    const range = request.headers.get("Range");
    if (!range) return plainResponse();
    if (range === "bytes=0-0") {
      return new Response(bytes.slice(0, 1), {
        status: 206,
        headers: {
          "Content-Range": `bytes 0-0/${bytes.length}`,
          "Content-Type": "image/png",
          "Cache-Control": "private, max-age=300",
        },
      });
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) throw new Error(`unsupported range: ${range}`);
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), bytes.length - 1);
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
        "Content-Type": "image/png",
      },
    });
  });
}

describe("isPlatformErrorPage", () => {
  it("matches only the platform's HTML error pages", () => {
    const html500 = new Response("<html></html>", {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
    const html502 = new Response("<html></html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    });
    const json500 = new Response(JSON.stringify({ error: "boom" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
    const html404 = new Response("<html></html>", {
      status: 404,
      headers: { "Content-Type": "text/html" },
    });

    expect(sw.isPlatformErrorPage(html500)).toBe(true);
    expect(sw.isPlatformErrorPage(html502)).toBe(true);
    expect(sw.isPlatformErrorPage(json500)).toBe(false);
    expect(sw.isPlatformErrorPage(html404)).toBe(false);
  });
});

describe("parseRange", () => {
  it("parses open-ended, closed, bounded and suffix ranges", () => {
    expect(sw.parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(sw.parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(sw.parseRange("bytes=-20", 100)).toEqual({ start: 80, end: 99 });
    expect(sw.parseRange("bytes=0-999", 100)).toEqual({ start: 0, end: 99 });
  });

  it("rejects invalid and multi-range headers", () => {
    expect(sw.parseRange("bytes=200-300", 100)).toBeNull();
    expect(sw.parseRange("bytes=0-10,20-30", 100)).toBeNull();
    expect(sw.parseRange("items=0-1", 100)).toBeNull();
    expect(sw.parseRange("bytes=-", 100)).toBeNull();
  });
});

describe("stitchWithRanges", () => {
  it("assembles a plain request into one full response", async () => {
    const total = sw.CHUNK_BYTES + 1024;
    const bytes = makeBody(total);
    const fetchMock = rangedFetch(bytes, () => {
      throw new Error("unqualified request should not be issued by the stitcher");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await sw.stitchWithRanges(new Request(FILE_URL));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBeNull();

    const assembled = new Uint8Array(await response.arrayBuffer());
    expect(assembled.length).toBe(total);
    expect(Array.from(assembled.subarray(0, 64))).toEqual(Array.from(bytes.subarray(0, 64)));
    expect(Array.from(assembled.subarray(total - 64))).toEqual(Array.from(bytes.subarray(total - 64)));

    // probe (1 byte) + ceil(total / CHUNK_BYTES) chunk reads
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const ranges = fetchMock.mock.calls.map(
      (call) => (call[0] instanceof Request ? call[0] : new Request(call[0])).headers.get("Range"),
    );
    expect(ranges).toEqual([
      "bytes=0-0",
      `bytes=0-${sw.CHUNK_BYTES - 1}`,
      `bytes=${sw.CHUNK_BYTES}-${total - 1}`,
    ]);
  });

  it("honours an original Range header and answers 206", async () => {
    const total = sw.CHUNK_BYTES + 1024;
    const bytes = makeBody(total);
    globalThis.fetch = rangedFetch(bytes, () => {
      throw new Error("unqualified request should not be issued by the stitcher");
    }) as unknown as typeof fetch;

    const request = new Request(FILE_URL, { headers: { Range: "bytes=10-19" } });
    const response = await sw.stitchWithRanges(request);

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 10-19/${total}`);
    const assembled = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(assembled)).toEqual(Array.from(bytes.slice(10, 20)));
  });
});

describe("handleFileRequest", () => {
  it("passes successful responses through untouched", async () => {
    const fetchMock = vi.fn(
      async () => new Response("small file", { status: 200, headers: { "Content-Type": "image/png" } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await sw.handleFileRequest(new Request(FILE_URL));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("small file");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes our own JSON errors through instead of stitching", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Permission denied" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await sw.handleFileRequest(new Request(FILE_URL));

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers from the platform's HTML 500 page by stitching ranges", async () => {
    const bytes = makeBody(sw.CHUNK_BYTES + 1024);
    const fetchMock = rangedFetch(bytes, () => {
      const failure = new Response("<html>500</html>", {
        status: 500,
        headers: { "Content-Type": "text/html" },
      });
      return failure;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await sw.handleFileRequest(new Request(FILE_URL));

    expect(response.status).toBe(200);
    const assembled = new Uint8Array(await response.arrayBuffer());
    expect(assembled.length).toBe(bytes.length);
    expect(Array.from(assembled.subarray(0, 64))).toEqual(Array.from(bytes.subarray(0, 64)));

    // failed plain fetch + probe + 2 chunk reads
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("falls back to the original error when stitching also fails", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("<html>500</html>", {
          status: 500,
          headers: { "Content-Type": "text/html" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await sw.handleFileRequest(new Request(FILE_URL));

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("text/html");
    // failed plain fetch + failed probe
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
