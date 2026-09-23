/**
 * EdgeOne Cloud Function — catch-all under /u/:username/ (one or more
 * segments). Serves /u/:username/rss.xml via the Hono app. The /u/:username
 * SPA profile page has no extra path segment, so it falls through to the
 * SPA fallback (index.html) and client-side routing still works.
 */
import { handleRequest } from "../../handler";

export const onRequest = handleRequest;
