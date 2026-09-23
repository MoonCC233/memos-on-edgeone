/**
 * EdgeOne Cloud Function — catch-all for /api/*.
 * File name [[default]].ts makes this match every path under /api/.
 */
import { handleRequest } from "../handler";

export const onRequest = handleRequest;
