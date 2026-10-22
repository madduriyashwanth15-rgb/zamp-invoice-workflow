// Gemini transports (spec 14): the only file that knows the provider's wire format. The API key travels in a
// header, never in the URL. Two styles, chosen with GEMINI_API:
//   interactions (default)  POST /v1beta/interactions, the API Google's docs now lead with (checked 22 Oct 2026).
//                           store=false so requests are not kept; thinking level low by default.
//   generate_content        POST /v1beta/models/{model}:generateContent, documented as legacy but supported.
// Google advises leaving temperature at its default for Gemini 3 models, so neither transport sets it.
// Until the live run (npm run test:live) has passed, the response shapes below are taken from the docs only.

export interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

export interface GeminiRequest {
  model: string;
  parts: GeminiPart[];
  /** Ask for JSON output. */
  json: boolean;
}

export type GeminiResponse =
  | { ok: true; text: string }
  | { ok: false; retryable: boolean; status: number | null; message: string };

export interface GeminiTransport {
  generate(req: GeminiRequest): Promise<GeminiResponse>;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const TIMEOUT_HINT = "no answer before the time limit";

/** A timeout (our AbortController) reads as such, not as "This operation was aborted". */
function describeFetchError(e: unknown, timeout: string): string {
  if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) return `timeout: ${timeout}`;
  return e instanceof Error ? e.message : String(e);
}

export class FetchGeminiTransport implements GeminiTransport {
  constructor(
    private apiKey: string,
    private baseUrl = "https://generativelanguage.googleapis.com/v1beta",
    private timeoutMs = 60_000,
  ) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  }

  async generate(req: GeminiRequest): Promise<GeminiResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/models/${encodeURIComponent(req.model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: req.parts }],
          ...(req.json ? { generationConfig: { responseMimeType: "application/json" } } : {}),
        }),
        signal: ctrl.signal,
      });
      const body = await res.text();
      if (!res.ok) return { ok: false, retryable: RETRYABLE.has(res.status), status: res.status, message: body.slice(0, 500) };
      const parsed = JSON.parse(body) as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[] };
      const text = parsed.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (!text) return { ok: false, retryable: true, status: res.status, message: `empty response (finishReason ${parsed.candidates?.[0]?.finishReason ?? "none"})` };
      return { ok: true, text };
    } catch (e) {
      return { ok: false, retryable: true, status: null, message: describeFetchError(e, TIMEOUT_HINT) };
    } finally {
      clearTimeout(timer);
    }
  }
}

interface InteractionStep {
  type?: string;
  content?: { type?: string; text?: string }[];
}

export class InteractionsGeminiTransport implements GeminiTransport {
  constructor(
    private apiKey: string,
    private opts: { thinkingLevel?: string | null; baseUrl?: string; timeoutMs?: number } = {},
  ) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  }

  async generate(req: GeminiRequest): Promise<GeminiResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 60_000);
    const input = req.parts.map((p) =>
      p.inline_data
        ? { type: p.inline_data.mime_type.startsWith("image/") ? "image" : "document", data: p.inline_data.data, mime_type: p.inline_data.mime_type }
        : { type: "text", text: p.text ?? "" },
    );
    const thinking = this.opts.thinkingLevel === undefined ? "low" : this.opts.thinkingLevel;
    try {
      const res = await fetch(`${this.opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"}/interactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          model: req.model,
          input,
          store: false,
          ...(req.json ? { response_format: { type: "text", mime_type: "application/json" } } : {}),
          ...(thinking ? { generation_config: { thinking_level: thinking } } : {}),
        }),
        signal: ctrl.signal,
      });
      const body = await res.text();
      if (!res.ok) return { ok: false, retryable: RETRYABLE.has(res.status), status: res.status, message: body.slice(0, 500) };
      const parsed = JSON.parse(body) as { status?: string; steps?: InteractionStep[] };
      const text = (parsed.steps ?? [])
        .filter((st) => st.type === "model_output")
        .flatMap((st) => st.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      if (!text) return { ok: false, retryable: true, status: res.status, message: `no text output (status ${parsed.status ?? "unknown"})` };
      return { ok: true, text };
    } catch (e) {
      return { ok: false, retryable: true, status: null, message: describeFetchError(e, TIMEOUT_HINT) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Picks the transport from the environment (GEMINI_API, GEMINI_THINKING_LEVEL, GEMINI_TIMEOUT_MS). */
export function transportFromEnv(apiKey: string, env: Record<string, string | undefined> = process.env): GeminiTransport {
  const t = Number(env.GEMINI_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(t) && t >= 5_000 && t <= 90_000 ? t : 60_000; // capped: see the time budget in gemini-extractor.ts
  if ((env.GEMINI_API ?? "interactions") === "generate_content") return new FetchGeminiTransport(apiKey, undefined, timeoutMs);
  const level = env.GEMINI_THINKING_LEVEL;
  return new InteractionsGeminiTransport(apiKey, { thinkingLevel: level === undefined ? "low" : level === "" || level === "default" ? null : level, timeoutMs });
}
