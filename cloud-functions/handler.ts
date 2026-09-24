/**
 * Shared EdgeOne Node.js function handler.
 * Adapts EdgeOne's function context to the Hono app's fetch interface.
 *
 * This file exports no onRequest handler, so the builder treats it as an
 * auxiliary module (imported by the route entry files, never routed itself).
 */
// NOTE: the specifier is deliberately BARE, not "../worker/src/index".
// The EdgeOne builder's framework detector only recurses through relative
// imports (Sit/Jbe) and its esbuild probe (TXr) resolves without nodePaths,
// so a bare specifier makes both detection passes bail out with
// isFramework:false. That is required: hono framework mode rewrites the
// request URL to a prefix-stripped path and expects a default-exported app
// (`return stdin_default`), which breaks this app and caused 502s.
// The actual bundler (ZKe) resolves the specifier via nodePaths:[cwd].
// The type comes from the ambient declaration in worker-src.d.ts.
import { app } from "worker/src/index";

export async function handleRequest(context: any): Promise<Response> {
  // Create a mutable copy of the environment.
  // EdgeOne's context.env may be read-only / specially prototyped, and the
  // app mutates env (initProviders attaches lazily-initialized DB/BUCKET).
  // NOTE: deliberately NOT named "env" — the builder flattens node_modules
  // into this module scope, and some transitive deps (e.g. the AWS SDK's
  // user-agent module) import a named `env` binding from the "process"
  // builtin, which collides with a local `env` binding at build time
  // (esbuild error: "The symbol env has already been declared").
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
