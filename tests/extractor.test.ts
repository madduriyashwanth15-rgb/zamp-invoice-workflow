import { afterEach, describe, expect, it, vi } from "vitest";
import { eventsOf, retry } from "@/domain/runs/review";
import type { PipelineDeps } from "@/domain/runs/pipeline";
import { GeminiExtractor, GeminiMappingProposer, MemoryExtractionCache } from "@/server/extractor/gemini-extractor";
import { FetchGeminiTransport, InteractionsGeminiTransport, transportFromEnv, type GeminiRequest, type GeminiResponse, type GeminiTransport } from "@/server/extractor/gemini-transport";
import { EXTRACTION_PROMPT_VERSION } from "@/server/extractor/prompt";
import { deliver, makeDeps, reference, tests } from "./support/harness";

// Extractor module (plan phase E, test matrix F1, F5, F9) against a MOCK provider: ScriptedTransport plays back
// canned provider answers. The extractor, schema, retries, cache, pipeline and rule engine are the real code.
// Whether the real Gemini API answers in this shape is checked separately by tests/live (needs a key).

class ScriptedTransport implements GeminiTransport {
  requests: GeminiRequest[] = [];
  constructor(private script: GeminiResponse[]) {}
  async generate(req: GeminiRequest): Promise<GeminiResponse> {
    this.requests.push(structuredClone(req));
    const next = this.script.shift();
    if (!next) throw new Error("ScriptedTransport: no scripted answer left");
    return next;
  }
}

const ok = (value: unknown): GeminiResponse => ({ ok: true, text: typeof value === "string" ? value : JSON.stringify(value) });
const http = (status: number, retryable = true): GeminiResponse => ({ ok: false, retryable, status, message: `HTTP ${status}` });
const s1 = () => structuredClone(tests.get("S1")!.expected_extraction) as Record<string, unknown>;
const noSleep = vi.fn(async () => {});

function withGemini(script: GeminiResponse[], cache = new MemoryExtractionCache()) {
  const transport = new ScriptedTransport(script);
  const extractor = new GeminiExtractor({ model: "gemini-test-model", transport, reference, cache, sleep: noSleep });
  const deps: PipelineDeps = { ...makeDeps(), extractor };
  return { deps, transport, extractor, cache };
}

afterEach(() => {
  noSleep.mockClear();
  vi.unstubAllGlobals();
});

describe("GeminiExtractor through the pipeline (MOCK provider)", () => {
  it("S1 happy path: one call, the document goes in as base64, the run clears", async () => {
    const { deps, transport } = withGemini([ok(s1())]);
    const run = await deliver(deps, "S1", {});
    expect(run.state).toBe("CLEARED");
    expect(transport.requests).toHaveLength(1);
    const req = transport.requests[0];
    expect(req.model).toBe("gemini-test-model");
    expect(req.json).toBe(true);
    expect(req.parts[0].text).toContain(reference.settings.buyer.gstin);
    expect(req.parts[1].inline_data?.mime_type).toBe("application/pdf");
    expect(Buffer.from(req.parts[1].inline_data!.data, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    expect(run.extracted_by).toEqual({ extractor: `Gemini gemini-test-model (${EXTRACTION_PROMPT_VERSION})`, attempts: 1, cached: false, retries: [] });
    const decided = (await eventsOf(deps, run.run_id)).find((e) => e.type === "DECIDED");
    expect(JSON.stringify(decided?.details)).toContain(EXTRACTION_PROMPT_VERSION);
  });

  it("numbers sent instead of decimal strings and a code fence around the JSON are accepted without arithmetic", async () => {
    const e = s1();
    e.total = Number(e.total);
    (e.lines as Record<string, unknown>[])[0].qty = Number((e.lines as Record<string, unknown>[])[0].qty);
    const { deps } = withGemini([ok("```json\n" + JSON.stringify(e) + "\n```")]);
    const run = await deliver(deps, "S1", {});
    expect(run.state).toBe("CLEARED");
    expect(run.extraction?.total).toBe(String(Number(s1().total)));
  });

  it("F1: schema-invalid twice -> ON_HOLD EXTRACTION_FAILED; the second call carries the validation errors", async () => {
    const bad = { ...s1(), doc_type: "receipt" };
    const { deps, transport } = withGemini([ok(bad), ok(bad)]);
    const run = await deliver(deps, "S1", {});
    expect(run.state).toBe("ON_HOLD");
    expect(run.blocking_codes).toEqual(["EXTRACTION_FAILED"]);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1].parts.at(-1)?.text).toMatch(/rejected by validation: doc_type/);
  });

  it("schema-invalid once, then valid -> the second answer is used", async () => {
    const { deps, transport } = withGemini([ok("not json at all"), ok(s1())]);
    const run = await deliver(deps, "S1", {});
    expect(run.state).toBe("CLEARED");
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1].parts.at(-1)?.text).toMatch(/not valid JSON/);
  });

  it("F9: the buyer's own GSTIN as vendor_gstin on both attempts -> ON_HOLD EXTRACTION_FAILED", async () => {
    const bad = { ...s1(), vendor_gstin: reference.settings.buyer.gstin };
    const { deps } = withGemini([ok(bad), ok(bad)]);
    const run = await deliver(deps, "S1", {});
    expect(run.state).toBe("ON_HOLD");
    expect(run.blocking_codes).toEqual(["EXTRACTION_FAILED"]);
    const held = (await eventsOf(deps, run.run_id)).find((e) => e.code === "EXTRACTION_FAILED");
    expect(JSON.stringify(held?.details)).toContain("buyer's own GSTIN");
  });

  it("F5: 503 on all three attempts -> FAILED PROCESSING_ERROR, no decision, backoff 500 then 1000 ms", async () => {
    const { deps, transport } = withGemini([http(503), http(503), http(503)]);
    const run = await deliver(deps, "S1", {});
    expect(run.state).toBe("FAILED");
    expect(run.engine).toBeNull();
    expect(run.failure).toMatch(/PROCESSING_ERROR: 503/);
    expect(transport.requests).toHaveLength(3);
    expect(noSleep.mock.calls).toEqual([[500], [1000]]);
    expect((await eventsOf(deps, run.run_id)).some((e) => e.type === "DECIDED")).toBe(false);
  });

  it("429 then success -> one decision, no failure; the run records why the first call did not count", async () => {
    const { deps, transport } = withGemini([http(429), ok(s1())]);
    const run = await deliver(deps, "S1", {});
    expect(run.state).toBe("CLEARED");
    expect(transport.requests).toHaveLength(2);
    expect(run.extracted_by?.retries).toEqual([expect.stringMatching(/^call 1: 429 HTTP 429 \(\d+(\.\d)? s\)$/)]);
  });

  it("a rejected answer is recorded as a retry reason too", async () => {
    const { deps } = withGemini([ok({ ...s1(), doc_type: "receipt" }), ok(s1())]);
    const run = await deliver(deps, "S1", {});
    expect(run.state).toBe("CLEARED");
    expect(run.extracted_by?.retries?.[0]).toMatch(/^call 1: answer rejected by validation \(doc_type/);
  });

  it("a non-retryable error (400) fails after one call", async () => {
    const { deps, transport } = withGemini([http(400, false)]);
    const run = await deliver(deps, "S1", {});
    expect(run.state).toBe("FAILED");
    expect(transport.requests).toHaveLength(1);
  });

  it("T9 with the real extractor: FAILED after 503s, retry succeeds on the same run id", async () => {
    const { deps, transport } = withGemini([http(503), http(503), http(503), ok(s1())]);
    const run = await deliver(deps, "S1", {});
    expect(run.state).toBe("FAILED");
    const r = await retry(deps, run.run_id, { actor: "Divya (AP)" });
    expect(r.ok && r.value.run_id).toBe(run.run_id);
    expect(r.ok && r.value.state).toBe("CLEARED");
    expect(transport.requests).toHaveLength(4);
  });
});

describe("extraction cache (sha256 + prompt version + model)", () => {
  const input = { filename: "a.pdf", content_type: "application/pdf", bytes: new Uint8Array([1, 2, 3]), text_layer: "", sha256: "abc123" };

  it("a repeat of the same document is served from the cache without a provider call", async () => {
    const { extractor, transport } = withGemini([ok(s1())]);
    const first = await extractor.extract(input);
    const second = await extractor.extract(input);
    expect(first.status).toBe("ok");
    expect(second).toMatchObject({ status: "ok", attempts: 0, cached: true });
    expect(transport.requests).toHaveLength(1);
  });

  it("a different model misses the cache; failures are never cached", async () => {
    const cache = new MemoryExtractionCache();
    const a = new GeminiExtractor({ model: "model-a", transport: new ScriptedTransport([ok(s1())]), reference, cache, sleep: noSleep });
    await a.extract(input);
    const tb = new ScriptedTransport([http(400, false), ok(s1())]);
    const b = new GeminiExtractor({ model: "model-b", transport: tb, reference, cache, sleep: noSleep });
    expect((await b.extract(input)).status).toBe("transport_error");
    expect((await b.extract(input)).status).toBe("ok");
    expect(tb.requests).toHaveLength(2);
  });
});

describe("GeminiMappingProposer (M2, MOCK provider)", () => {
  it("S14: a valid proposal is verified by code and the line is LINE_MAPPED_AI_VERIFIED", async () => {
    const gt = (tests.get("S14")!.ai_mapping_ground_truth as { proposed_po_line: number; pack_size_read: number; justification: string }[])[0];
    const deps: PipelineDeps = {
      ...makeDeps(),
      proposer: new GeminiMappingProposer({ model: "gemini-test-model", reference, transport: new ScriptedTransport([ok(gt)]) }),
    };
    const run = await deliver(deps, "S14", {});
    expect(run.state).toBe("CLEARED");
    expect(run.info_codes).toContain("LINE_MAPPED_AI_VERIFIED");
  });

  it("a malformed mapping answer proposes nothing: the line stays unmapped and held, never guessed", async () => {
    for (const answer of [ok("{oops"), ok({ proposed_po_line: "one", justification: 3 })]) {
      const deps: PipelineDeps = {
        ...makeDeps(),
        proposer: new GeminiMappingProposer({ model: "m", reference, transport: new ScriptedTransport([answer]), sleep: noSleep }),
      };
      const run = await deliver(deps, "S14", {});
      expect(run.state).toBe("ON_HOLD");
      expect(run.blocking_codes).toContain("LINE_UNMAPPED");
    }
  });

  it("P5: the mapping call unreachable 3 times -> FAILED PROCESSING_ERROR (a system error is not a hold); retry decides", async () => {
    const deps: PipelineDeps = {
      ...makeDeps(),
      proposer: new GeminiMappingProposer({ model: "m", reference, transport: new ScriptedTransport([http(503), http(503), http(503)]), sleep: noSleep }),
    };
    const run = await deliver(deps, "S14", {});
    expect(run.state).toBe("FAILED");
    expect(run.failure).toMatch(/line mapping call failed: 503/);
    const gt = (tests.get("S14")!.ai_mapping_ground_truth as { proposed_po_line: number; pack_size_read: number; justification: string }[])[0];
    const again = await retry({ ...deps, proposer: new GeminiMappingProposer({ model: "m", reference, transport: new ScriptedTransport([ok(gt)]) }) }, run.run_id, { actor: "Divya (AP)" });
    expect(again.ok && again.value.state).toBe("CLEARED");
  });
});

/** MOCK provider where every call takes `ms` of fake time, so the time budget can be tested without waiting. */
class SlowTransport implements GeminiTransport {
  calls = 0;
  constructor(private clock: { t: number }, private ms: number, private answer: () => GeminiResponse) {}
  async generate(): Promise<GeminiResponse> {
    this.calls++;
    this.clock.t += this.ms;
    return this.answer();
  }
}

describe("time budget (Vercel Hobby stops a function at 300 s)", () => {
  it("extraction starts no new call after 120 s: slow 503s end FAILED with the reason, not cut off mid-run", async () => {
    const clock = { t: 0 };
    const transport = new SlowTransport(clock, 70_000, () => http(503));
    const extractor = new GeminiExtractor({ model: "m", transport, reference, sleep: noSleep, now: () => clock.t });
    const deps: PipelineDeps = { ...makeDeps(), extractor };
    const run = await deliver(deps, "S1", {});
    expect(transport.calls).toBe(2); // 70 s, then 140 s: past the budget, so no third call
    expect(run.state).toBe("FAILED");
    expect(run.failure).toMatch(/time budget used up after 2 calls \(140 s\)/);
    expect(run.extracted_by?.retries?.at(-1)).toMatch(/120 s time budget was used up/);
  });

  it("a fast failure inside the budget is still retried", async () => {
    const clock = { t: 0 };
    let n = 0;
    const transport = new SlowTransport(clock, 20_000, () => (++n === 1 ? http(503) : ok(s1())));
    const extractor = new GeminiExtractor({ model: "m", transport, reference, sleep: noSleep, now: () => clock.t });
    const run = await deliver({ ...makeDeps(), extractor }, "S1", {});
    expect(transport.calls).toBe(2);
    expect(run.state).toBe("CLEARED");
  });

  it("a line-mapping call that used up its 45 s is not retried: the run is FAILED (retryable), never guessed", async () => {
    const clock = { t: 0 };
    const transport = new SlowTransport(clock, 50_000, () => http(503));
    const proposer = new GeminiMappingProposer({ model: "m", reference, transport, sleep: noSleep, now: () => clock.t });
    const run = await deliver({ ...makeDeps(), proposer }, "S14", {});
    expect(transport.calls).toBe(1);
    expect(run.state).toBe("FAILED");
    expect(run.failure).toMatch(/45 s time budget was used up after 1 call$/);
  });

  it("GEMINI_TIMEOUT_MS sets the per-call timeout within 5-90 s; anything else falls back to 60 s", () => {
    const timeoutOf = (env: Record<string, string>) => (transportFromEnv("k", env) as unknown as { opts: { timeoutMs: number } }).opts.timeoutMs;
    expect(timeoutOf({ GEMINI_TIMEOUT_MS: "45000" })).toBe(45_000);
    expect(timeoutOf({ GEMINI_TIMEOUT_MS: "600000" })).toBe(60_000);
    expect(timeoutOf({})).toBe(60_000);
  });
});

describe("FetchGeminiTransport wire format (fetch stubbed, no network)", () => {
  const req: GeminiRequest = { model: "gemini-x", json: true, parts: [{ text: "hi" }] };
  const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  it("generateContent: key in a header (never the URL), JSON output, no temperature override", async () => {
    const fetchMock = vi.fn(async () => reply(200, { candidates: [{ content: { parts: [{ text: '{"a":' }, { text: "1}" }] } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await new FetchGeminiTransport("secret-key").generate(req);
    expect(res).toEqual({ ok: true, text: '{"a":1}' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
    expect(url).not.toContain("secret-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("secret-key");
    expect(JSON.parse(init.body as string)).toEqual({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { responseMimeType: "application/json" },
    });
  });

  it("classifies failures: 429/503 and network errors retryable, 400 not, empty answer retryable", async () => {
    const t = new FetchGeminiTransport("k");
    vi.stubGlobal("fetch", vi.fn(async () => reply(429, "quota")));
    expect(await t.generate(req)).toMatchObject({ ok: false, retryable: true, status: 429 });
    vi.stubGlobal("fetch", vi.fn(async () => reply(400, "bad")));
    expect(await t.generate(req)).toMatchObject({ ok: false, retryable: false, status: 400 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await t.generate(req)).toMatchObject({ ok: false, retryable: true, status: null });
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { candidates: [{ finishReason: "SAFETY" }] })));
    expect(await t.generate(req)).toMatchObject({ ok: false, retryable: true, message: expect.stringContaining("SAFETY") });
  });

  it("refuses to start without a key", () => {
    expect(() => new FetchGeminiTransport("")).toThrow(/GEMINI_API_KEY/);
  });
});

describe("InteractionsGeminiTransport wire format (fetch stubbed, no network)", () => {
  const pdfReq: GeminiRequest = { model: "gemini-x", json: true, parts: [{ text: "read" }, { inline_data: { mime_type: "application/pdf", data: "JVBERi0=" } }] };

  it("posts to /interactions with document input, store false, JSON format and low thinking; reads model_output text", async () => {
    const fetchMock = vi.fn(async () => Response.json({ object: "interaction", status: "completed", steps: [{ type: "user_input" }, { type: "model_output", content: [{ type: "text", text: '{"a":' }, { type: "text", text: "1}" }] }] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await new InteractionsGeminiTransport("k-1").generate(pdfReq);
    expect(res).toEqual({ ok: true, text: '{"a":1}' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k-1");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gemini-x",
      input: [{ type: "text", text: "read" }, { type: "document", data: "JVBERi0=", mime_type: "application/pdf" }],
      store: false,
      response_format: { type: "text", mime_type: "application/json" },
      generation_config: { thinking_level: "low" },
    });
  });

  it("images go in as image parts; no text output is a retryable failure; 400 is not retryable", async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: "failed", steps: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const t = new InteractionsGeminiTransport("k", { thinkingLevel: null });
    const r = await t.generate({ model: "m", json: false, parts: [{ inline_data: { mime_type: "image/png", data: "iVBO" } }] });
    expect(r).toMatchObject({ ok: false, retryable: true });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.input[0].type).toBe("image");
    expect(body.generation_config).toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad request", { status: 400 })));
    expect(await t.generate(pdfReq)).toMatchObject({ ok: false, retryable: false, status: 400 });
  });

  it("transportFromEnv: interactions by default, generateContent on request", () => {
    expect(transportFromEnv("k", {})).toBeInstanceOf(InteractionsGeminiTransport);
    expect(transportFromEnv("k", { GEMINI_API: "generate_content" })).toBeInstanceOf(FetchGeminiTransport);
  });
});
