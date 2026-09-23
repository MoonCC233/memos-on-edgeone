/**
 * Shared EdgeOne Node.js function handler.
 * Adapts EdgeOne's function context to the Hono app's fetch interface.
 *
 * This file exports no onRequest handler, so the builder treats it as an
 * auxiliary module (imported by the route entry files, never routed itself).
 */
import { app } from "../worker/src/index";

export async function handleRequest(context: any): Promise<Response> {
  // Create a mutable copy of the environment.
  // EdgeOne's context.env may be read-only / specially prototyped, and the
  // app mutates env (initProviders attaches lazily-initialized DB/BUCKET).
  // NOTE: deliberately NOT named "env" — the EdgeOne builder injects
  // `import { env } from "process"` into each entry bundle, and a local
  // binding named env collides with it at build time (esbuild error:
  // "The symbol env has already been declared").
  const fnEnv: any = { ...context.env };

  // Minimal ExecutionContext compatible with Hono / Web Standards.
  const executionCtx = {
    waitUntil(promise: Promise<any>) {
      promise.catch((err) => console.error("waitUntil task failed:", err));
    },
    passThroughOnException() {},
    props: {},
  };

  return app.fetch(context.request, fnEnv, executionCtx);
}
