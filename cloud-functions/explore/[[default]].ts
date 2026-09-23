/**
 * EdgeOne Cloud Function — catch-all under /explore/ (one or more segments).
 * Serves /explore/rss.xml via the Hono app. The /explore SPA page itself has
 * no extra path segment, so it falls through to the SPA fallback.
 */
import { handleRequest } from "../handler";

export const onRequest = handleRequest;
