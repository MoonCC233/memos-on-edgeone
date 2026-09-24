/**
 * Ambient declaration for the deliberately bare "worker/src/index" import in
 * handler.ts (see the comment there). Type-only: invisible to esbuild, so it
 * does not re-enable the framework detector that the bare specifier defeats.
 */
declare module "worker/src/index" {
  export const app: {
    fetch(
      request: Request,
      env: unknown,
      executionCtx?: unknown
    ): Promise<Response>;
  };
}
