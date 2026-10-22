import { z } from "zod";
import type { MappingProposal, MappingProposer, MappingRequest, ReferenceData } from "@/domain/engine/types";
import { extractionSchema, type Extraction } from "@/domain/extraction-schema";
import type { ExtractionAttempt, Extractor, ExtractorInput } from "@/domain/runs/pipeline";
import type { GeminiTransport } from "./gemini-transport";
import { EXTRACTION_PROMPT_VERSION, MAPPING_PROMPT_VERSION, extractionPrompt, mappingPrompt, retryFeedback } from "./prompt";

// One read-and-classify call per document (spec 14): transport errors retried 3 times, schema-invalid answers
// retried twice with the validation errors fed back, results cached by sha256 + prompt version + model.

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
  transport: GeminiTransport;
  reference: ReferenceData;
  cache?: ExtractionCache;
  /** Backoff between transport attempts; injectable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
  transportAttempts?: number;
  schemaAttempts?: number;
}

const DECIMAL_FIELDS = ["subtotal", "cgst", "sgst", "igst", "tax_total", "total"] as const;
const LINE_DECIMALS = ["qty", "unit_price", "amount", "gst_rate"] as const;

/** Models sometimes send numbers where we asked for decimal strings; convert without arithmetic. */
function coerce(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const o = { ...(raw as Record<string, unknown>) };
  for (const f of DECIMAL_FIELDS) if (typeof o[f] === "number") o[f] = String(o[f]);
  if (Array.isArray(o.lines)) {
    o.lines = o.lines.map((l: Record<string, unknown>) => {
      const x = { ...l };
      for (const f of LINE_DECIMALS) if (typeof x[f] === "number") x[f] = String(x[f]);
      if (typeof x.hsn_sac === "number") x.hsn_sac = String(x.hsn_sac);
      return x;
    });
  }
  if (o.currency == null) o.currency = "INR";
  if (o.revision_marker == null) o.revision_marker = false;
  return o;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export class GeminiExtractor implements Extractor {
  readonly label: string;
  private schema;
  constructor(private o: GeminiExtractorOptions) {
    this.label = `Gemini ${o.model} (${EXTRACTION_PROMPT_VERSION})`;
    this.schema = extractionSchema(o.reference.settings);
  }

  cacheKey(sha256: string | null): string | null {
    return sha256 ? `${sha256}|${EXTRACTION_PROMPT_VERSION}|${this.o.model}` : null;
  }

  async extract(input: ExtractorInput): Promise<ExtractionAttempt> {
    const key = this.cacheKey(input.sha256);
    if (key && this.o.cache) {
      const hit = await this.o.cache.get(key);
      if (hit) return { status: "ok", extraction: hit, attempts: 0, label: this.label, cached: true };
    }
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const maxTransport = this.o.transportAttempts ?? 3;
    const maxSchema = this.o.schemaAttempts ?? 2;
    const base = [
      { text: extractionPrompt(this.o.reference.settings) },
      { inline_data: { mime_type: input.content_type, data: toBase64(input.bytes) } },
    ];
    let feedback: string[] | null = null;
    let calls = 0;
    for (let s = 1; s <= maxSchema; s++) {
      let text: string | null = null;
      for (let t = 1; t <= maxTransport; t++) {
        calls++;
        const res = await this.o.transport.generate({ model: this.o.model, json: true, parts: feedback ? [...base, { text: retryFeedback(feedback) }] : base });
        if (res.ok) {
          text = res.text;
          break;
        }
        if (!res.retryable || t === maxTransport) {
          return { status: "transport_error", error: `${res.status ?? "network"}: ${res.message}`, attempts: calls, label: this.label };
        }
        await sleep(500 * 2 ** (t - 1));
      }
      let json: unknown;
      try {
        json = JSON.parse(text!.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      } catch (e) {
        feedback = [`not valid JSON (${e instanceof Error ? e.message : e})`];
        continue;
      }
      const parsed = this.schema.safeParse(coerce(json));
      if (parsed.success) {
        if (key && this.o.cache) await this.o.cache.set(key, parsed.data);
        return { status: "ok", extraction: parsed.data, attempts: calls, label: this.label };
      }
      feedback = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    }
    return { status: "schema_invalid", errors: feedback ?? ["unknown"], attempts: calls, label: this.label };
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
  constructor(private o: { model: string; transport: GeminiTransport; reference: ReferenceData; sleep?: (ms: number) => Promise<void> }) {
    this.label = `Gemini ${o.model} (${MAPPING_PROMPT_VERSION})`;
  }
  async propose(req: MappingRequest): Promise<MappingProposal | null> {
    const prompt = mappingPrompt({
      description: req.line.description, qty: req.line.qty, uom: req.line.uom, unit_price: req.line.unit_price,
      candidates: req.candidates.map((c) => ({ line_no: c.line_no, description: c.description, uom: c.uom, item_code: c.item_code })),
      catalog: this.o.reference.catalog,
    });
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let t = 1; t <= 3; t++) {
      const res = await this.o.transport.generate({ model: this.o.model, json: true, parts: [{ text: prompt }] });
      if (res.ok) {
        try {
          const p = proposalSchema.safeParse(JSON.parse(res.text.replace(/^```(?:json)?\s*|\s*```$/g, "")));
          return p.success ? p.data : null;
        } catch {
          return null;
        }
      }
      if (!res.retryable || t === 3) throw new ProposerUnavailableError(`line mapping call failed: ${res.status ?? "network"} ${res.message}`);
      await sleep(500 * 2 ** (t - 1));
    }
    return null;
  }
}
