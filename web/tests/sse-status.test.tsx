import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SSEConnectionStatus, useLiveMemoRefresh, useSSEConnectionStatus } from "@/hooks/useLiveMemoRefresh";

const fetchMock = vi.fn();

const deps = vi.hoisted(() => ({
  getAccessToken: vi.fn(() => "test-token"),
  currentUser: { name: "users/alice", displayName: "Alice", role: "USER" },
}));

vi.mock("@/auth-state", () => ({
  REQUEST_TOKEN_EXPIRY_BUFFER_MS: 30_000,
  clearAccessToken: vi.fn(),
  getAccessToken: deps.getAccessToken,
  hasStoredToken: vi.fn(() => true),
  isTokenExpired: vi.fn(() => false),
  setAccessToken: vi.fn(),
  shouldAttemptTokenRefresh: vi.fn(() => false),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: deps.currentUser }),
}));

vi.mock("@/hooks/useMemoQueries", () => ({
  memoKeys: {
    all: ["memos"],
    lists: () => ["memos"],
    detail: (name: string) => ["memos", name],
    comments: (parent: string) => ["memos", parent, "comments"],
  },
}));

vi.mock("@/hooks/useUserQueries", () => ({
  userKeys: {
    stats: () => ["users", "stats"],
  },
}));

type ReadResult = { done: boolean; value?: Uint8Array };

/**
 * A minimal stand-in for `new Response(readable, ...)` whose body can be fed
 * and closed by the test, so a connection can stay open and then be dropped
 * exactly the way EdgeOne closes the stream at `maxDuration`.
 */
function createOpenStream(initialChunk: string) {
  const encoder = new TextEncoder();
  const queued: ReadResult[] = [{ done: false, value: encoder.encode(initialChunk) }];
  let waiting: ((result: ReadResult) => void) | null = null;

  const emit = (result: ReadResult) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(result);
      return;
    }
    queued.push(result);
  };

  const reader = {
    read(): Promise<ReadResult> {
      const next = queued.shift();
      if (next) return Promise.resolve(next);
      return new Promise<ReadResult>((resolve) => {
        waiting = resolve;
      });
    },
  };

  return {
    response: {
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    } as unknown as Response,
    /** Simulates the platform/network closing the stream. */
    close: () => emit({ done: true }),
  };
}

function createWrapper() {
  const queryClient = new QueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

/** Drain the promise chain inside `connect()` (all of it is microtask awaits). */
async function drain() {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

/** Advance fake time, then let the resulting connection attempt settle. */
async function settle(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await drain();
  });
}

/**
 * A fetch implementation whose response only shows up `ms` later, so a test
 * can observe the status while an attempt is still in flight (writes made
 * before and after the response would otherwise batch into one render).
 */
function openStreamAfter(ms: number) {
  return () =>
    new Promise<Response>((resolve) => {
      setTimeout(() => resolve(createOpenStream(": connected\n\n").response), ms);
    });
}

/** Close a live stream and let the client observe the drop. */
async function dropStream(stream: ReturnType<typeof createOpenStream>) {
  await act(async () => {
    stream.close();
    await drain();
  });
}

function renderStatusHook() {
  const statuses: SSEConnectionStatus[] = [];
  const { result } = renderHook(
    () => {
      useLiveMemoRefresh();
      const status = useSSEConnectionStatus();
      statuses.push(status);
      return status;
    },
    { wrapper: createWrapper() },
  );
  // The status store is a module-level singleton that survives across tests,
  // and the effect writes its first status synchronously during render. Drop
  // both so each assertion only sees transitions produced by this test.
  statuses.length = 0;
  return { statuses, result };
}

beforeEach(() => {
  vi.useFakeTimers();
  deps.getAccessToken.mockImplementation(() => "test-token");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SSE connection status", () => {
  it("never paints red while reconnecting after the stream is closed", async () => {
    const streams: Array<ReturnType<typeof createOpenStream>> = [];
    fetchMock.mockImplementation(async () => {
      const stream = createOpenStream(": connected\n\n");
      streams.push(stream);
      return stream.response;
    });

    const { statuses, result } = renderStatusHook();

    await settle(0);
    expect(result.current).toBe("connected");

    // Server closes the stream (execution limit): grey, then reconnect.
    await dropStream(streams[0]);
    expect(result.current).toBe("connecting");

    await settle(1000);
    expect(result.current).toBe("connected");

    // Second cycle: still no red.
    await dropStream(streams[1]);
    await settle(1000);
    expect(result.current).toBe("connected");

    expect(statuses).not.toContain("disconnected");
  });

  it("turns red only after repeated attempts that never delivered data, then stays red", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const { statuses, result } = renderStatusHook();

    await settle(0);
    expect(result.current).toBe("connecting");

    await settle(1000);
    expect(result.current).toBe("connecting");

    // Third consecutive failure latches the red state.
    await settle(2000);
    expect(result.current).toBe("disconnected");

    // The next attempt hangs without delivering anything: while it is in
    // flight the latched status must not flash back to grey.
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    await settle(4000);
    expect(result.current).toBe("disconnected");

    const firstRed = statuses.indexOf("disconnected");
    expect(firstRed).toBeGreaterThanOrEqual(0);
    expect(statuses.slice(firstRed)).not.toContain("connecting");
    expect(statuses.slice(firstRed)).not.toContain("connected");
  });

  it("recovers straight to connected once the endpoint delivers data again", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const { statuses, result } = renderStatusHook();

    await settle(0);
    await settle(1000);
    await settle(2000);
    expect(result.current).toBe("disconnected");

    fetchMock.mockImplementation(openStreamAfter(500));

    // Attempt 4 starts while the response is still in flight: the latched red
    // must survive it instead of flashing grey.
    await settle(4000);
    expect(result.current).toBe("disconnected");

    const firstRed = statuses.indexOf("disconnected");
    expect(firstRed).toBeGreaterThanOrEqual(0);
    expect(statuses.slice(firstRed)).not.toContain("connecting");

    // First byte arrives → healthy again, straight back to green.
    await settle(500);
    expect(result.current).toBe("connected");
    expect(statuses.slice(firstRed)).not.toContain("connecting");
  });
});
