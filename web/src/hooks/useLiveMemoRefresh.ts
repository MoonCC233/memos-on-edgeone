import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { getAccessToken } from "@/auth-state";
import { useAuth } from "@/contexts/AuthContext";
import { memoKeys } from "@/hooks/useMemoQueries";
import { userKeys } from "@/hooks/useUserQueries";

/**
 * Reconnection parameters for SSE connection.
 */
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const RETRY_BACKOFF_MULTIPLIER = 2;

/**
 * How many consecutive attempts may fail before the UI latches the red
 * "disconnected" state.
 *
 * Reconnecting is normal — EdgeOne Cloud Functions terminate the SSE stream at
 * `maxDuration`, so every session ends with a drop + immediate retry. Those
 * transient reconnects must stay in the grey "connecting" state; only a
 * sustained failure (several attempts in a row that never delivered a byte)
 * escalates to red. Once latched, the status stays red across further retry
 * attempts so the dot cannot flicker red/grey.
 */
const MAX_FAILED_ATTEMPTS_BEFORE_RED = 3;

const SSE_EVENT_TYPES = {
  memoCreated: "memo.created",
  memoUpdated: "memo.updated",
  memoDeleted: "memo.deleted",
  memoCommentCreated: "memo.comment.created",
  reactionUpserted: "reaction.upserted",
  reactionDeleted: "reaction.deleted",
} as const;

// ---------------------------------------------------------------------------
// Shared connection status store (singleton)
// ---------------------------------------------------------------------------

export type SSEConnectionStatus = "connected" | "disconnected" | "connecting";

type Listener = () => void;

let _status: SSEConnectionStatus = "connecting";
const _listeners = new Set<Listener>();

function getSSEStatus(): SSEConnectionStatus {
  return _status;
}

function setSSEStatus(s: SSEConnectionStatus) {
  if (_status !== s) {
    _status = s;
    _listeners.forEach((l) => l());
  }
}

function subscribeSSEStatus(listener: Listener): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

/**
 * React hook that returns the current SSE connection status.
 * Re-renders the component whenever the status changes.
 */
export function useSSEConnectionStatus(): SSEConnectionStatus {
  return useSyncExternalStore(subscribeSSEStatus, getSSEStatus, getSSEStatus);
}

// ---------------------------------------------------------------------------
// Main hook
// ---------------------------------------------------------------------------

/**
 * useLiveMemoRefresh connects to the server's SSE endpoint and
 * invalidates relevant React Query caches when change events
 * (memos, reactions) are received.
 *
 * This enables real-time updates across all open instances of the app.
 */
export function useLiveMemoRefresh() {
  const queryClient = useQueryClient();
  const { currentUser } = useAuth();
  const retryDelayRef = useRef(INITIAL_RETRY_DELAY_MS);
  const abortControllerRef = useRef<AbortController | null>(null);
  const hasConnectedOnceRef = useRef(false);
  const failedAttemptsRef = useRef(0);

  const currentUserName = currentUser?.name;
  const handleEvent = useCallback((event: SSEChangeEvent) => handleSSEEvent(event, queryClient), [queryClient]);

  useEffect(() => {
    let mounted = true;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;

    const scheduleRetry = () => {
      if (!mounted) return;
      const delay = retryDelayRef.current;
      retryDelayRef.current = Math.min(delay * RETRY_BACKOFF_MULTIPLIER, MAX_RETRY_DELAY_MS);
      retryTimeout = setTimeout(connect, delay);
    };

    const connect = async () => {
      if (!mounted) return;

      const token = getAccessToken();
      if (!token) {
        if (!currentUserName) {
          // Not logged in; do not retry. Effect will re-run when currentUser
          // is set (login).
          failedAttemptsRef.current = 0;
          setSSEStatus("disconnected");
          return;
        }
        // Logged in but the stored token is missing/expired — another API call
        // may refresh it at any moment, so keep checking (cheap, local only)
        // instead of latching a permanent red dot on the first miss. Fixed
        // delay: this is not a failing network attempt, so no backoff.
        failedAttemptsRef.current += 1;
        setSSEStatus(failedAttemptsRef.current >= MAX_FAILED_ATTEMPTS_BEFORE_RED ? "disconnected" : "connecting");
        retryTimeout = setTimeout(connect, INITIAL_RETRY_DELAY_MS);
        return;
      }

      // Only advertise "connecting" (grey) while we are still inside the
      // transient-failure window. After the status has latched "disconnected"
      // further attempts must not flip it back to grey, otherwise every retry
      // cycle paints the dot red again and it flickers.
      if (failedAttemptsRef.current < MAX_FAILED_ATTEMPTS_BEFORE_RED) {
        setSSEStatus("connecting");
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      // Whether the stream actually delivered bytes. Headers alone (a 200 with
      // a body that never flushes) do not count as a healthy connection.
      let receivedData = false;

      try {
        const response = await fetch("/api/v1/sse", {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal: abortController.signal,
          credentials: "include",
        });

        if (!response.ok || !response.body) {
          throw new Error(`SSE connection failed: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (mounted) {
          const { done, value } = await reader.read();
          if (done) break;

          if (!receivedData) {
            receivedData = true;
            // First byte proves the platform really streams this response —
            // only now is the connection healthy enough to report "connected".
            failedAttemptsRef.current = 0;
            retryDelayRef.current = INITIAL_RETRY_DELAY_MS;
            setSSEStatus("connected");
            if (hasConnectedOnceRef.current) {
              // Resync active collaborative views after reconnect because the server may have
              // dropped events while the client was disconnected or backpressured.
              queryClient.invalidateQueries({ queryKey: memoKeys.all, refetchType: "active" });
              queryClient.invalidateQueries({ queryKey: userKeys.stats(), refetchType: "active" });
            }
            hasConnectedOnceRef.current = true;
          }

          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE messages (separated by double newlines).
          const messages = buffer.split("\n\n");
          // Keep the last incomplete chunk in the buffer.
          buffer = messages.pop() || "";

          for (const message of messages) {
            if (!message.trim()) continue;

            // Parse SSE format: lines starting with "data: " contain JSON payload.
            // Lines starting with ":" are comments (heartbeats).
            for (const line of message.split("\n")) {
              if (line.startsWith("data: ")) {
                const jsonStr = line.slice(6);
                try {
                  const event = JSON.parse(jsonStr) as SSEChangeEvent;
                  handleEvent(event);
                } catch {
                  // Ignore malformed JSON.
                }
              }
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // Intentional abort (effect cleanup / logout) — no reconnect, and the
          // cleanup already owns the status. Avoid writing "disconnected" here
          // so a re-running effect does not flash red before it recovers.
          return;
        }
        // Connection lost or failed - fall through to the retry below.
      }

      if (!mounted) return;

      if (receivedData) {
        // Normal end of stream: the platform closed it (execution limit) or
        // the network dropped it. Go straight back to "connecting" so the
        // dot never shows an error state for an expected reconnect.
        failedAttemptsRef.current = 0;
        setSSEStatus("connecting");
      } else {
        // Attempt ended without a single byte — count it as a failure.
        failedAttemptsRef.current += 1;
        setSSEStatus(failedAttemptsRef.current >= MAX_FAILED_ATTEMPTS_BEFORE_RED ? "disconnected" : "connecting");
      }

      // Reconnect with exponential backoff.
      scheduleRetry();
    };

    connect();

    return () => {
      mounted = false;
      // Handing over to the next effect run (or tearing down) — keep the dot
      // neutral instead of painting a red "disconnected" flash.
      failedAttemptsRef.current = 0;
      retryDelayRef.current = INITIAL_RETRY_DELAY_MS;
      setSSEStatus("connecting");
      if (retryTimeout) {
        clearTimeout(retryTimeout);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [handleEvent, currentUserName]);
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

interface SSEChangeEvent {
  type: (typeof SSE_EVENT_TYPES)[keyof typeof SSE_EVENT_TYPES];
  name: string;
  parent?: string;
}

function handleSSEEvent(event: SSEChangeEvent, queryClient: ReturnType<typeof useQueryClient>) {
  switch (event.type) {
    case SSE_EVENT_TYPES.memoCreated:
      queryClient.invalidateQueries({ queryKey: memoKeys.lists() });
      queryClient.invalidateQueries({ queryKey: userKeys.stats() });
      break;

    case SSE_EVENT_TYPES.memoUpdated:
      queryClient.invalidateQueries({ queryKey: memoKeys.detail(event.name) });
      queryClient.invalidateQueries({ queryKey: memoKeys.lists() });
      if (event.parent) {
        queryClient.invalidateQueries({ queryKey: memoKeys.comments(event.parent) });
      }
      break;

    case SSE_EVENT_TYPES.memoDeleted:
      queryClient.removeQueries({ queryKey: memoKeys.detail(event.name) });
      queryClient.invalidateQueries({ queryKey: memoKeys.lists() });
      queryClient.invalidateQueries({ queryKey: userKeys.stats() });
      break;

    case SSE_EVENT_TYPES.memoCommentCreated:
      queryClient.invalidateQueries({ queryKey: memoKeys.comments(event.name) });
      queryClient.invalidateQueries({ queryKey: memoKeys.detail(event.name) });
      break;

    case SSE_EVENT_TYPES.reactionUpserted:
    case SSE_EVENT_TYPES.reactionDeleted:
      queryClient.invalidateQueries({ queryKey: memoKeys.detail(event.name) });
      queryClient.invalidateQueries({ queryKey: memoKeys.lists() });
      if (event.parent) {
        queryClient.invalidateQueries({ queryKey: memoKeys.comments(event.parent) });
      }
      break;
  }
}
