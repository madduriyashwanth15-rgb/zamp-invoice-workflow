import Decimal from "decimal.js";
import { z } from "zod";
import type { MappingProposal, MappingProposer, MappingRequest, ReferenceData } from "@/domain/engine/types";
import { extractionSchema, type Extraction } from "@/domain/extraction-schema";
import type { ExtractionAttempt, Extractor, ExtractorInput } from "@/domain/runs/pipeline";
import type { GeminiTransport } from "./gemini-transport";
import { EXTRACTION_PROMPT_VERSION, MAPPING_PROMPT_VERSION, extractionPrompt, mappingPrompt, retryFeedback } from "./prompt";

// One read-and-classify call per document (spec 14): transport errors retried 3 times, schema-invalid answers
// retried twice with the validation errors fed back, results cached by sha256 + prompt version + model.
//
// Backup model (optional, GEMINI_FALLBACK_MODEL): after a retryable failure of the main model (overload, quota,
// timeout), the remaining attempts go to the backup model. The run records which model actually read it. The
// number of attempts and the time budget are unchanged.
//
// Time budget: processing runs inside one serverless invocation, and Vercel Hobby stops a function at 300 s.
// No new call is started once the budget is spent, so a run always ends as decided or FAILED (retryable) inside
// that limit instead of being cut off mid-way. Worst case: budget + one call's timeout.

export interface ExtractionCache {
  get(key: string): Promise<Extraction | null>;
  set(key: string, value: Extraction): Promise<void>;
}

export class MemoryExtractionCache implements ExtractionCache {
  private m = new Map<string, Extraction>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: Extraction) {
    this.m.set(k, structuredClone(v));
  }
}

export interface GeminiExtractorOptions {
  model: string;
  /** Used for the remaining attempts after a retryable failure of `model`. */
  fallbackModel?: string | null;
  transport: GeminiTransport;
  reference: ReferenceData;
  cache?: ExtractionCache;
  /** Backoff between transport attempts; injectable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
  transportAttempts?: number;
  schemaAttempts?: number;
  /** Clock for per-call timings and the budget; injectable for tests. */
  now?: () => number;
  /** No new provider call is started after this many ms (default EXTRACTION_BUDGET_MS). */
  budgetMs?: number;
}

// With the 60 s per-call timeout: extraction ends by about 120 + 60 + backoff = 182 s, one line-mapping proposal by
// about 45 + 60 = 105 s, so even S14 (read, then one mapping proposal) stays under 300 s in the worst case.
export const EXTRACTION_BUDGET_MS = 120_000;
export const MAPPING_BUDGET_MS = 45_000;

const DECIMAL_FIELDS = ["subtotal", "cgst", "sgst", "igst", "tax_total", "total"] as const;
const LINE_DECIMALS = ["qty", "unit_price", "amount", "gst_rate"] as const;

/** Models sometimes send numbers where we asked for decimal strings; convert without arithmetic. */
/**
 * A number copied with its thousands separators ("6,000.00", Indian "1,00,000.00") loses only the separators.
 * Anything else (a decimal comma, a currency sign, words) is left for the schema to reject.
 */
function ungroup(v: unknown): unknown {
  if (typeof v === "number") return String(v);
  if (typeof v === "string" && /^\d{1,3}(,\d{2,3})+(\.\d+)?$/.test(v.trim())) return v.trim().replace(/,/g, "");
  return v;
}

function coerce(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const o = { ...(raw as Record<string, unknown>) };
  for (const f of DECIMAL_FIELDS) o[f] = ungroup(o[f]);
  if (Array.isArray(o.lines)) {
    o.lines = o.lines.map((l: Record<string, unknown>) => {
      const x = { ...l };
      for (const f of LINE_DECIMALS) x[f] = ungroup(x[f]);
      if (typeof x.hsn_sac === "number") x.hsn_sac = String(x.hsn_sac);
      return x;
    });
  }
  // The model copies the account number; code takes the last 4 digits (live run, 22 Oct: asked for "the last 4",
  // the model answered 2778 for A/c 30987654327781). An answer that put the whole number into the last-4 field is
  // read the same way.
  const digits = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\D/g, "") : "");
  const printed = digits(o.bank_account_number);
  const short = digits(o.bank_account_last4);
  o.bank_account_last4 = printed.length >= 4 ? printed.slice(-4) : short.length >= 4 ? short.slice(-4) : null;
  if (typeof o.bank_account_number === "number") o.bank_account_number = String(o.bank_account_number);
  if (o.currency == null) o.currency = "INR";
  if (o.revision_marker == null) o.revision_marker = false;
  return o;
}

/**
 * When no tax total is printed (only CGST/SGST or IGST lines), code adds the printed components so the record
 * matches the extraction schema. The model is told not to do this sum itself (live run, 22 Oct: it did so on one
 * invoice and not on two others with the same layout).
 */
export function withTaxTotal(e: Extraction): Extraction {
  const parts = [e.cgst, e.sgst, e.igst ?? null].filter((v): v is string => v != null);
  if (e.tax_total != null || parts.length === 0) return e;
  return { ...e, tax_total: parts.reduce((s, v) => s.plus(v), new Decimal(0)).toFixed(2) };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

const labelOf = (model: string, version: string) => `Gemini ${model} (${version})`;

export class GeminiExtractor implements Extractor {
  readonly label: string;
  private schema;
  constructor(private o: GeminiExtractorOptions) {
    this.label = labelOf(o.model, EXTRACTION_PROMPT_VERSION);
    this.schema = extractionSchema(o.reference.settings);
  }

  cacheKey(sha256: string | null, model = this.o.model): string | null {
    return sha256 ? `${sha256}|${EXTRACTION_PROMPT_VERSION}|${model}` : null;
  }

  async extract(input: ExtractorInput): Promise<ExtractionAttempt> {
    const models = [this.o.model, ...(this.o.fallbackModel && this.o.fallbackModel !== this.o.model ? [this.o.fallbackModel] : [])];
    if (this.o.cache) {
      for (const m of models) {
        const k = this.cacheKey(input.sha256, m);
        const hit = k ? await this.o.cache.get(k) : null;
        if (hit) return { status: "ok", extraction: hit, attempts: 0, label: labelOf(m, EXTRACTION_PROMPT_VERSION), cached: true };
      }
    }
    let model = models[0];
    const label = () => labelOf(model, EXTRACTION_PROMPT_VERSION);
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const maxTransport = this.o.transportAttempts ?? 3;
    const maxSchema = this.o.schemaAttempts ?? 2;
    const base = [
      { text: extractionPrompt(this.o.reference.settings) },
      { inline_data: { mime_type: input.content_type, data: toBase64(input.bytes) } },
    ];
    let feedback: string[] | null = null;
    let calls = 0;
    // Why each call before the successful one did not count (kept on the run: timeouts, overload, rejected answers).
    const retries: string[] = [];
    const clock = this.o.now ?? (() => Date.now());
    const begin = clock();
    const budget = this.o.budgetMs ?? EXTRACTION_BUDGET_MS;
    const outOfTime = () => {
      const spent = Math.round((clock() - begin) / 1000);
      retries.push(`stopped: the ${Math.round(budget / 1000)} s time budget was used up (${spent} s, ${plural(calls, "call")})`);
      return { status: "transport_error" as const, error: `time budget used up after ${plural(calls, "call")} (${spent} s)`, attempts: calls, label: label(), retries };
    };
    for (let s = 1; s <= maxSchema; s++) {
      let text: string | null = null;
      for (let t = 1; t <= maxTransport; t++) {
        if (calls > 0 && clock() - begin > budget) return outOfTime();
        calls++;
        const started = clock();
        const res = await this.o.transport.generate({ model, json: true, parts: feedback ? [...base, { text: retryFeedback(feedback) }] : base });
        const secs = Math.round((clock() - started) / 100) / 10;
        if (res.ok) {
          text = res.text;
          break;
        }
        retries.push(`call ${calls} (${model}): ${res.status ?? "network"} ${res.message.slice(0, 120)} (${secs} s)`);
        if (!res.retryable || t === maxTransport) {
          return { status: "transport_error", error: `${res.status ?? "network"}: ${res.message}`, attempts: calls, label: label(), retries };
        }
        if (models.length > 1 && model === models[0]) model = models[1];
        await sleep(500 * 2 ** (t - 1));
      }
      let json: unknown;
      try {
        json = JSON.parse(text!.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      } catch (e) {
        feedback = [`not valid JSON (${e instanceof Error ? e.message : e})`];
        retries.push(`call ${calls}: answer was ${feedback[0]}`);
        continue;
      }
      const parsed = this.schema.safeParse(coerce(json));
      if (parsed.success) {
        const extraction = withTaxTotal(parsed.data);
        const key = this.cacheKey(input.sha256, model);
        if (key && this.o.cache) await this.o.cache.set(key, extraction);
        return { status: "ok", extraction, attempts: calls, label: label(), retries };
      }
      feedback = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      retries.push(`call ${calls}: answer rejected by validation (${feedback.slice(0, 3).join("; ")})`);
    }
    return { status: "schema_invalid", errors: feedback ?? ["unknown"], attempts: calls, label: label(), retries };
  }
}

const proposalSchema = z.object({
  proposed_po_line: z.number().int().nullable(),
  pack_size_read: z.number().int().nullable(),
  justification: z.string(),
});

/** A mapping call that could not reach the model: the run fails (P5: a system error is never turned into a hold). */
export class ProposerUnavailableError extends Error {}

/**
 * M2: one mapping call per line that M1 cannot map. A malformed answer proposes nothing (the line stays unmapped
 * and held); a transport failure after 3 attempts throws, so the run ends FAILED and can be retried.
 */
export class GeminiMappingProposer implements MappingProposer {
  readonly label: string;
  constructor(private o: { model: string; fallbackModel?: string | null; transport: GeminiTransport; reference: ReferenceData; sleep?: (ms: number) => Promise<void>; now?: () => number; budgetMs?: number }) {
    this.label = labelOf(o.model, MAPPING_PROMPT_VERSION);
  }
  async propose(req: MappingRequest): Promise<MappingProposal | null> {
    const prompt = mappingPrompt({
      description: req.line.description, qty: req.line.qty, uom: req.line.uom, unit_price: req.line.unit_price,
      candidates: req.candidates.map((c) => ({ line_no: c.line_no, description: c.description, uom: c.uom, item_code: c.item_code })),
      catalog: this.o.reference.catalog,
    });
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const clock = this.o.now ?? (() => Date.now());
    const begin = clock();
    const budget = this.o.budgetMs ?? MAPPING_BUDGET_MS;
    let model = this.o.model;
    for (let t = 1; t <= 3; t++) {
      if (t > 1 && clock() - begin > budget) {
        throw new ProposerUnavailableError(`line mapping call: the ${Math.round(budget / 1000)} s time budget was used up after ${plural(t - 1, "call")}`);
      }
      const res = await this.o.transport.generate({ model, json: true, parts: [{ text: prompt }] });
      if (res.ok) {
        try {
          const p = proposalSchema.safeParse(JSON.parse(res.text.replace(/^```(?:json)?\s*|\s*```$/g, "")));
          return p.success ? { ...p.data, by: labelOf(model, MAPPING_PROMPT_VERSION) } : null;
        } catch {
          return null;
        }
      }
      if (!res.retryable || t === 3) throw new ProposerUnavailableError(`line mapping call failed: ${res.status ?? "network"} ${res.message}`);
      if (this.o.fallbackModel && model === this.o.model) model = this.o.fallbackModel;
      await sleep(500 * 2 ** (t - 1));
    }
    return null;
  }
}
