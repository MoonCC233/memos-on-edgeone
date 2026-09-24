/**
 * EdgeOne Cloud Function — single dynamic segment under /u/:username/.
 * Serves /u/:username/rss.xml via the Hono app.
 *
 * Deliberately single-level (`[rest]`, not a `[[default]]` catch-all):
 * the builders' handler-mode dispatch for multi-level routes with a dynamic
 * segment before the catch-all (`/u/:username/:default*`) generates a literal
 * `startsWith("/u/:username/")` check that never matches real paths. A
 * single-level route instead dispatches via a real regex over the full
 * pathname, so the request reaches Hono with its original URL intact.
 * Platform routing (`^/u/([^/]+)/([^/]*)?$`) also excludes bare /u/:username,
 * so the SPA profile page still falls through to the fallback (index.html).
 */
import { handleRequest } from "../../handler";

export const onRequest = handleRequest;
