/**
 * EdgeOne Cloud Function — /u/:username/rss.xml
 * Only this exact path shape is routed here; other /u/* paths fall through
 * to the SPA fallback (index.html) so client-side profile pages still work.
 */
import { handleRequest } from "../../handler";

export const onRequest = handleRequest;
