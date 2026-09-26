import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("@/auth-state", () => ({
  REQUEST_TOKEN_EXPIRY_BUFFER_MS: 30_000,
  clearAccessToken: vi.fn(),
  getAccessToken: vi.fn(() => null),
  hasStoredToken: vi.fn(() => false),
  shouldAttemptTokenRefresh: vi.fn(() => false),
  isTokenExpired: vi.fn(() => false),
  setAccessToken: vi.fn(),
}));

const SMALL_FILE = new Uint8Array(1024);
const LARGE_FILE = new Uint8Array(6 * 1024 * 1024); // over the 5 MiB multipart threshold

const PRE_SIGNED_URL = "https://blob.example/put/attachments/xyz/big.png";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: unknown): string {
  return typeof input === "string" ? input : (input as Request).url;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("attachment upload routing", () => {
  it("keeps files at or below the threshold on the multipart endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 1, uid: "small", filename: "a.png", type: "image/png", size: SMALL_FILE.length }, 201),
    );

    const { attachmentServiceClient } = await import("@/connect");
    const result = await attachmentServiceClient.createAttachment({
      attachment: { filename: "a.png", type: "image/png", content: SMALL_FILE },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/attachments");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(fetchMock.mock.calls[0][1].body).toBeInstanceOf(FormData);
    expect(result.uid).toBe("small");
  });

  it("sends large files straight to storage instead of through the function", async () => {
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "/api/v1/attachments/upload-url") {
        return jsonResponse({
          url: PRE_SIGNED_URL,
          key: "attachments/xyz/big.png",
          expiresAt: 1,
          token: "upload-ticket",
        });
      }
      if (url === PRE_SIGNED_URL) {
        expect(init?.method).toBe("PUT");
        return new Response(null, { status: 200 });
      }
      if (url === "/api/v1/attachments/complete") {
        return jsonResponse({ id: 9, uid: "big", filename: "big.png", type: "image/png", size: LARGE_FILE.length }, 201);
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const { attachmentServiceClient } = await import("@/connect");
    const result = await attachmentServiceClient.createAttachment({
      attachment: { filename: "big.png", type: "image/png", content: LARGE_FILE },
    });

    const urls = fetchMock.mock.calls.map((call) => requestUrl(call[0]));
    expect(urls).toEqual([
      "/api/v1/attachments/upload-url",
      PRE_SIGNED_URL,
      "/api/v1/attachments/complete",
    ]);
    // The multi-megabyte body must never travel through the function.
    expect(urls).not.toContain("/api/v1/attachments");

    const ticketRequest = fetchMock.mock.calls[0][1];
    expect(JSON.parse(ticketRequest.body)).toEqual({
      filename: "big.png",
      type: "image/png",
      size: LARGE_FILE.length,
      memo: null,
    });

    const put = fetchMock.mock.calls[1][1];
    expect(put.headers["Content-Type"]).toBe("image/png");
    expect(put.body.size).toBe(LARGE_FILE.length);
    expect(put.credentials).toBe("omit");

    const completeRequest = fetchMock.mock.calls[2][1];
    expect(JSON.parse(completeRequest.body)).toEqual({
      token: "upload-ticket",
      memo: null,
      put: { status: 200, etag: "", bodyBytes: 0 },
    });

    expect(result.uid).toBe("big");
  });

  it("reports a clear error when the presigned PUT itself fails", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = requestUrl(input);
      if (url === "/api/v1/attachments/upload-url") {
        return jsonResponse({ url: PRE_SIGNED_URL, key: "attachments/xyz/big.png", expiresAt: 1, token: "t" });
      }
      if (url === PRE_SIGNED_URL) {
        throw new TypeError("Failed to fetch");
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const { attachmentServiceClient } = await import("@/connect");
    await expect(
      attachmentServiceClient.createAttachment({
        attachment: { filename: "big.png", type: "image/png", content: LARGE_FILE },
      }),
    ).rejects.toThrow(/Direct upload failed/);
  });

  it("rejects a 2xx HTML answer from the storage endpoint", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = requestUrl(input);
      if (url === "/api/v1/attachments/upload-url") {
        return jsonResponse({ url: PRE_SIGNED_URL, key: "attachments/xyz/big.png", expiresAt: 1, token: "t" });
      }
      if (url === PRE_SIGNED_URL) {
        // A redirect landing on an error page would otherwise look like a
        // successful PUT and produce a confusing "not found in storage".
        return new Response("<html>nope</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const { attachmentServiceClient } = await import("@/connect");
    await expect(
      attachmentServiceClient.createAttachment({
        attachment: { filename: "big.png", type: "image/png", content: LARGE_FILE },
      }),
    ).rejects.toThrow(/HTML page/);
  });
});

describe("apiRequest error reporting", () => {
  it("keeps status context and names the likely cause for HTML error pages", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>error</html>", {
        status: 500,
        statusText: "Internal Error",
        headers: { "Content-Type": "text/html" },
      }),
    );

    const { apiRequest } = await import("@/api/client");
    const error = await apiRequest("GET", "/api/v1/instance/profile").catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("HTTP 500 Internal Error");
    expect(error.message).toContain("6 MB");
  });
});
