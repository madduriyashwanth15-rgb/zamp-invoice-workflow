import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { issuesOf } from "@/server/explain";
import { printedDates } from "@/domain/dates";
import { TEST_DATA_DIR } from "@/fixtures/load";
import { readTextLayer } from "@/server/pdf-text";
import { codes, evalDirect, extractionOf } from "./support/direct";
import { makeDeps, runGolden, tests } from "./support/harness";

// V3c (spec v1.4, 23 Oct; review gap 9): the invoice date the reader returns must be printed on the page as the
// same calendar day. Before this, V3 checked the number, amounts, PO and bank digits but not the date, so a misread
// date (which moves the due date) could clear. Real test PDFs, scripted (MOCK) readings, the real rule engine.

async function textOf(testId: string): Promise<string> {
  const file = path.join(TEST_DATA_DIR, String(tests.get(testId)!.file));
  return (await readTextLayer(new Uint8Array(readFileSync(file)), "application/pdf")).text;
}
const doc = (text: string) => ({ document: { text_layer: text, has_text_layer: true } });

describe("printedDates reads the ways Indian invoices print a date", () => {
  it.each([
    ["Date 12/10/2026", "2026-10-12"],
    ["Date 2/3/2026", "2026-03-02"],
    ["Bill date 16.10.2026", "2026-10-16"],
    ["Dated 12-10-26", "2026-10-12"],
    ["12 / 10 / 2026", "2026-10-12"],
    ["2026-10-12", "2026-10-12"],
    ["Invoice date 14-Oct-2026", "2026-10-14"],
    ["17 Oct 2026", "2026-10-17"],
    ["12th October, 2026", "2026-10-12"],
    ["1st of June 2026", "2026-06-01"],
    ["12 Sept 2026", "2026-09-12"],
    ["12 Oct '26", "2026-10-12"],
    ["October 12, 2026", "2026-10-12"],
    ["Oct. 12th 2026", "2026-10-12"],
  ])("%s -> %s", (text, iso) => {
    expect(printedDates(text).has(iso)).toBe(true);
  });

  it("numeric dates are day first: 10/12/2026 is 10 December, not 12 October", () => {
    expect([...printedDates("10/12/2026")]).toEqual(["2026-12-10"]);
  });

  it("not dates: an impossible day, invoice numbers, amounts, mixed separators", () => {
    expect(printedDates("31/02/2026 30.02.2026").size).toBe(0);
    expect(printedDates("Invoice No. FP-2026-0418, total 1,00,000.00, PO-7731").size).toBe(0);
    expect(printedDates("12/10-2026").size).toBe(0);
    expect(printedDates("Market 2026, Junk 12 2026").size).toBe(0);
  });
});

describe("V3c on the test documents", () => {
  const digital = ["S1", "S2", "S3", "S4", "S5", "S6a", "S6b", "S8", "S9", "S10", "S11", "S12", "S13", "S14", "X1", "X2", "X3"];

  it("every digital test document prints the invoice date its reading has (all four formats in the set)", async () => {
    for (const id of digital) {
      const iso = extractionOf(id).invoice_date!;
      expect(printedDates(await textOf(id)).has(iso), `${id} ${iso}`).toBe(true);
    }
  });

  it("and none of them gets EVIDENCE_NOT_FOUND from it", async () => {
    for (const id of digital) {
      const r = await evalDirect(extractionOf(id), doc(await textOf(id)));
      expect(codes(r), id).not.toContain("EVIDENCE_NOT_FOUND");
    }
  });

  it("a swap that lands in the past, which V5 (future dates) cannot see: S1 printed 05/10/2026, read as 10 May", async () => {
    const text = (await textOf("S1")).replace("12/10/2026", "05/10/2026");
    const right = await evalDirect({ ...extractionOf("S1"), invoice_date: "2026-10-05" }, doc(text));
    expect(right.outcome).toBe("CLEARED");
    const swapped = await evalDirect({ ...extractionOf("S1"), invoice_date: "2026-05-10" }, doc(text));
    expect(swapped.outcome).toBe("ON_HOLD");
    expect(codes(swapped)).toEqual(["EVIDENCE_NOT_FOUND"]);
    expect(swapped.blocking.find((f) => f.code === "EVIDENCE_NOT_FOUND")!.evidence.not_found).toEqual(["invoice date = 2026-05-10"]);
  });

  it("S1 (printed 12/10/2026) read as 10 December: V3c and V5 both hold it", async () => {
    const r = await evalDirect({ ...extractionOf("S1"), invoice_date: "2026-12-10" }, doc(await textOf("S1")));
    expect(codes(r)).toEqual(["DATE_INVALID", "EVIDENCE_NOT_FOUND"]);
  });

  it("S2 (printed 14-Oct-2026) read one day out: held", async () => {
    const r = await evalDirect({ ...extractionOf("S2"), invoice_date: "2026-10-13" }, doc(await textOf("S2")));
    expect(codes(r)).toContain("EVIDENCE_NOT_FOUND");
  });

  it("S13 (printed 17 Oct 2026) read with the wrong year: held", async () => {
    const r = await evalDirect({ ...extractionOf("S13"), invoice_date: "2025-10-17" }, doc(await textOf("S13")));
    expect(codes(r)).toContain("EVIDENCE_NOT_FOUND");
  });

  it("a scan has no text to check against: the date is not looked for (V4 holds it for a person instead)", async () => {
    const r = await evalDirect({ ...extractionOf("S1"), invoice_date: "2026-12-10" }, { document: { text_layer: "", has_text_layer: false } });
    expect(codes(r)).not.toContain("EVIDENCE_NOT_FOUND");
    expect(codes(r)).toContain("SCAN_UNVERIFIED");
  });
});

describe("the review screen names the date as a day", () => {
  it("the not-found value reads 'invoice date read as 10 May 2026', so a swapped day and month is visible", async () => {
    const text = (await textOf("S1")).replace("12/10/2026", "05/10/2026");
    const engine = await evalDirect({ ...extractionOf("S1"), invoice_date: "2026-05-10" }, doc(text));
    const s1 = (await runGolden()).find((g) => g.test.test_id === "S1")!.run;
    const run = { ...s1, state: "ON_HOLD" as const, engine, blocking_codes: ["EVIDENCE_NOT_FOUND" as const] };
    const [issue] = issuesOf({ run, ref: makeDeps().reference, refOf: (id) => id });
    expect(issue.explain).toContain("invoice date read as 10 May 2026");
    expect(issue.explain).not.toContain("2026-05-10");
  });
});
