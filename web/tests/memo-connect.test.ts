import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { State } from "@/types/proto/api/v1/common_pb";

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

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("memoServiceClient", () => {
  it("keeps archived memos archived when the worker returns state", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          memos: [
            {
              name: "memos/archived",
              state: "ARCHIVED",
              creator: "users/demo",
              createTime: "2026-05-31T00:00:00.000Z",
              updateTime: "2026-05-31T00:00:00.000Z",
              visibility: "PRIVATE",
              content: "archived memo",
            },
          ],
          nextPageToken: "",
          totalSize: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { memoServiceClient } = await import("@/connect");
    const response = await memoServiceClient.listMemos({ state: State.ARCHIVED });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("state=ARCHIVED"), expect.any(Object));
    expect(response.memos[0].state).toBe(State.ARCHIVED);
  });
});
