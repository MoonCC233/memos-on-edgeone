/**
 * EdgeOne Cloud Function — /explore/rss.xml
 * /explore itself falls through to the SPA fallback.
 */
import { handleRequest } from "../handler";

export const onRequest = handleRequest;
