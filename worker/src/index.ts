/**
 * EdgeOne Pages Functions Entry Point
 * Memos on EdgeOne - Main Worker Entry
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { authRequired } from "./middleware/auth";
import { initProviders } from "./middleware/providers";
import { authRoutes } from "./routes/auth";
import { memoRoutes } from "./routes/memos";
import { userRoutes } from "./routes/users";
import { attachmentRoutes } from "./routes/attachments";
import { fileRoutes } from "./routes/files";
import { instanceRoutes } from "./routes/instance";
import { healthRoutes } from "./routes/health";
import { shortcutRoutes } from "./routes/shortcuts";
import { idpRoutes } from "./routes/idp";
import { aiRoutes } from "./routes/ai";
import { sseRoutes } from "./routes/sse";
import { exploreRssRoutes, rssRoutes } from "./routes/rss";
import { findUserById } from "./db/user";
import { formatUser } from "./routes/users";

// Create Hono app with EdgeOne environment
const app = new Hono<{ Bindings: Env }>();

// Initialize providers middleware (runs before all routes)
app.use("*", initProviders);

// CORS for API routes
app.use("/api/*", cors({
  origin: "*",
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  exposeHeaders: ["Content-Length"],
  maxAge: 86400,
}));

// Health check (no auth)
app.route("/api/v1/health", healthRoutes);

// Auth routes
app.route("/api/v1/auth", authRoutes);

// Protected routes
app.get("/api/v1/user/me", authRequired, async (c) => {
  const currentUser = c.get("user");
  const user = await findUserById(c.env.DB, currentUser.id);
  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  const formattedUser = formatUser(user, { includeEmail: true });
  return c.json({
    user: formattedUser,
    ...formattedUser,
  });
});

app.route("/api/v1/memos", memoRoutes);
app.route("/api/v1/users", userRoutes);
app.route("/api/v1/attachments", attachmentRoutes);
app.route("/api/v1/instance", instanceRoutes);
app.route("/api/v1/shortcuts", shortcutRoutes);
app.route("/api/v1/idps", idpRoutes);
app.route("/api/v1/ai", aiRoutes);
app.route("/api/v1/sse", sseRoutes);
app.route("/file", fileRoutes);
// NOTE: /u/:username SPA pages are served by EdgeOne's static-asset SPA
// fallback (edgeone.json rewrites), not by a function. Only the RSS
// endpoints under /u and /explore are routed to Cloud Functions.
app.route("/u", rssRoutes);
app.route("/explore", exploreRssRoutes);

// 404 handler
app.notFound((c) => {
  return c.json({ code: 5, message: "Not Found", details: [] }, 404);
});

// Error handler
app.onError((err, c) => {
  if (err.message?.includes("Method Not Allowed")) {
    return c.json({ code: 12, message: "Method Not Allowed", details: [] }, 405);
  }
  console.error(err);
  return c.json({ code: 2, message: err.message || "Internal Server Error", details: [] }, 500);
});

// Named export: the Hono app, used by the EdgeOne Cloud Functions
// entry points under /cloud-functions.
export { app };

// Default export kept for compatibility (e.g. local tooling that expects a
// fetch-style handler).
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: { waitUntil: (p: Promise<any>) => void; passThroughOnException?: () => void }
  ): Promise<Response> {
    const executionCtx = {
      waitUntil: ctx.waitUntil.bind(ctx),
      passThroughOnException: ctx.passThroughOnException?.bind(ctx) ?? (() => {}),
      props: {},
    };
    return app.fetch(request, env, executionCtx);
  },
};