import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";
import * as settingDB from "../db/setting";

type AIApp = { Bindings: Env; Variables: { user: UserPayload } };

export const aiRoutes = new Hono<AIApp>();

const DEFAULT_TRANSCRIPTION_MODEL = "whisper-1";

// Build the OpenAI-compatible transcriptions URL from the configured base.
// Accepts ".../v1", ".../v1/", or a full ".../audio/transcriptions" URL.
export function buildTranscriptionsUrl(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, "");
  if (base.endsWith("/audio/transcriptions")) return base;
  return `${base}/audio/transcriptions`;
}

// Speech-to-text via the custom AI provider configured in 设置 → AI
// (OpenAI-compatible endpoint + API key stored in the AI instance setting).
aiRoutes.post("/transcribe", authRequired, async (c) => {
  const contentType = c.req.header("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json({ error: "Expected multipart/form-data" }, 400);
  }

  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "No audio file provided" }, 400);
  let language = String(formData.get("language") || "");

  let provider: { endpoint?: string; apiKey?: string } | undefined;
  let model = DEFAULT_TRANSCRIPTION_MODEL;
  let prompt = "";
  const aiSettingRow = await settingDB.getInstanceSetting(c.env.DB, "AI");
  if (aiSettingRow) {
    try {
      const parsed = JSON.parse(aiSettingRow.value);
      const providerId = parsed?.transcription?.providerId;
      if (providerId && Array.isArray(parsed.providers)) {
        provider = parsed.providers.find((p: any) => p && p.id === providerId);
      }
      const configuredModel = String(parsed?.transcription?.model || "");
      // Legacy Cloudflare model ids are meaningless against an OpenAI-compatible API.
      if (configuredModel && !configuredModel.startsWith("@cf/")) {
        model = configuredModel;
      }
      if (!language && parsed?.transcription?.language) {
        language = String(parsed.transcription.language);
      }
      prompt = String(parsed?.transcription?.prompt || "");
    } catch {
      // Fall through — the endpoint check below reports configuration issues.
    }
  }

  const endpoint = String(provider?.endpoint || "").trim();
  if (!endpoint) {
    return c.json(
      { error: "AI API endpoint not configured. Set it in Settings -> AI." },
      400,
    );
  }

  const upstream = new FormData();
  upstream.append("file", file, file.name || "audio.wav");
  upstream.append("model", model);
  if (language) upstream.append("language", language);
  if (prompt) upstream.append("prompt", prompt);

  const headers: Record<string, string> = {};
  const apiKey = String(provider?.apiKey || "");
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const timeoutSignal =
    typeof AbortSignal !== "undefined" && typeof (AbortSignal as any).timeout === "function"
      ? (AbortSignal as any).timeout(55_000)
      : undefined;

  let res: Response;
  try {
    res = await fetch(buildTranscriptionsUrl(endpoint), {
      method: "POST",
      headers,
      body: upstream,
      ...(timeoutSignal ? { signal: timeoutSignal } : {}),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return c.json(
      { error: timedOut ? "AI request timed out" : "Failed to reach the AI endpoint" },
      504,
    );
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    return c.json({ error: `AI API error (${res.status}): ${detail}` }, 502);
  }

  const data = (await res.json().catch(() => ({}))) as { text?: unknown };
  return c.json({ text: typeof data.text === "string" ? data.text : "" });
});
