import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";

type SSEApp = { Bindings: Env; Variables: { user: UserPayload } };

export const sseRoutes = new Hono<SSEApp>();

sseRoutes.get("/", authRequired, async (c) => {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  writer.write(encoder.encode(": connected\n\n"));

  // Keep connection alive with periodic heartbeats
  const interval = setInterval(async () => {
    try {
      await writer.write(encoder.encode(": heartbeat\n\n"));
    } catch {
      clearInterval(interval);
    }
  }, 30000);

  c.req.raw.signal.addEventListener("abort", () => {
    clearInterval(interval);
    writer.close().catch(() => {});
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});
