/**
 * EdgeOne Cloud Function — catch-all for /file/*.
 * Serves attachments and avatars from Blob/S3 storage.
 */
import { handleRequest } from "../handler";

export const onRequest = handleRequest;
