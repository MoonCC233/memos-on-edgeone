import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";

type SSEApp = { Bindings: Env; Variables: { user: UserPayload } };

export const sseRoutes = new Hono<SSEApp>();

// Keep well under typical edge/proxy idle timeouts (30-60s) so intermediaries
// do not reap an otherwise healthy stream between heartbeats.
const HEARTBEAT_INTERVAL_MS = 15000;

sseRoutes.get("/", authRequired, async (c) => {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Swallow rejection: if the client already hung up, an unhandled rejection
  // would take the whole Node function down mid-stream.
  writer.write(encoder.encode(": connected\n\n")).catch(() => {});

  // Keep connection alive with periodic heartbeats
  const interval = setInterval(async () => {
    try {
      await writer.write(encoder.encode(": heartbeat\n\n"));
    } catch {
      clearInterval(interval);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Not every runtime guarantees a signal on the incoming request — guard it,
  // otherwise a missing signal throws inside the handler and the client sees a
  // 500 for every reconnect attempt.
  const signal = c.req.raw.signal as AbortSignal | undefined;
  signal?.addEventListener("abort", () => {
    clearInterval(interval);
    writer.close().catch(() => {});
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      // `no-transform` stops any intermediary from buffering/rewriting the
      // stream; `X-Accel-Buffering: no` disables nginx-style proxy buffering.
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      // NOTE: no `Connection` header — it is a hop-by-hop header, forbidden in
      // HTTP/2, and runtimes that forward it can reject the whole response.
    },
  });
});
