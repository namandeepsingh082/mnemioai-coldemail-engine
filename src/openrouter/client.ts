import { OPENROUTER_API_KEY } from "../config.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export interface ChatResult {
  ok: boolean;
  content?: string;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls an OpenRouter chat model with retries + exponential backoff.
 * Returns ok:false (never throws) on exhausted retries, missing key, or
 * network failure, so callers can fall back to deterministic templates
 * instead of blocking the pipeline on a rate-limited free model.
 */
export async function chatCompletion(
  model: string,
  messages: { role: "system" | "user"; content: string }[],
  opts: { maxRetries?: number; timeoutMs?: number } = {}
): Promise<ChatResult> {
  if (!OPENROUTER_API_KEY) {
    return { ok: false, error: "no_api_key" };
  }

  const maxRetries = opts.maxRetries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages, temperature: 0.7 }),
      });

      if (res.status === 429 || res.status === 503) {
        const backoff = 1000 * 2 ** attempt + Math.random() * 300;
        await sleep(backoff);
        continue;
      }

      if (!res.ok) {
        return { ok: false, error: `http_${res.status}` };
      }

      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) return { ok: false, error: "empty_response" };
      return { ok: true, content };
    } catch (err) {
      if (attempt === maxRetries) {
        return { ok: false, error: err instanceof Error ? err.message : "unknown_error" };
      }
      await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, error: "exhausted_retries" };
}
