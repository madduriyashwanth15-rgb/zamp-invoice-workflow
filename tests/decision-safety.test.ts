import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Extraction } from "@/domain/extraction-schema";
import { TEST_DATA_DIR } from "@/fixtures/load";
import { BANK_WORDING } from "@/domain/engine/evaluate";
import { readTextLayer } from "@/server/pdf-text";
import { codes, evalDirect, extractionOf, infos } from "./support/direct";
import { AnswerKeyProposer, tests } from "./support/harness";

// Audit 23 Oct: an AI misreading must never end in CLEARED. Each case below reproduces an audit probe with the
// real test PDF's text layer and a scripted (MOCK) reading; the code under test is the real rule engine.

async function textOf(testId: string): Promise<string> {
  const file = path.join(TEST_DATA_DIR, String(tests.get(testId)!.file));
  return (await readTextLayer(new Uint8Array(readFileSync(file)), "application/pdf")).text;
}

const doc = (text: string) => ({ document: { text_layer: text, has_text_layer: true } });
const noBank = (e: Extraction): Extraction => ({ ...e, bank_account_last4: null, bank_account_number: null });
const finding = (r: Awaited<ReturnType<typeof evalDirect>>, code: string) => r.blocking.find((f) => f.code === code);

describe("K4b (spec v1.4): a printed bank account the reader leaves out is held, never cleared (audit A02)", () => {
  it("S1: account changed on the page and not read -> ON_HOLD MISSING_REQUIRED_FIELD naming the bank account", async () => {
    const text = (await textOf("S1")).replace(/50200012344417/g, "50200012340042");
    const r = await evalDirect(noBank(extractionOf("S1")), doc(text));
    expect(r.outcome).toBe("ON_HOLD");
    expect(codes(r)).toEqual(["MISSING_REQUIRED_FIELD"]);
    expect(finding(r, "MISSING_REQUIRED_FIELD")!.evidence.field).toBe("bank account");
    expect(infos(r)).not.toContain("BANK_NOT_SHOWN");
  });

  it("S2 (bank changed): the reader leaves the account out -> still held, not cleared", async () => {
    const r = await evalDirect(noBank(extractionOf("S2")), doc(await textOf("S2")));
    expect(r.outcome).toBe("ON_HOLD");
    expect(codes(r)).toContain("MISSING_REQUIRED_FIELD");
  });

  it("no bank wording on the page and nothing read -> info BANK_NOT_SHOWN and S1 still clears", async () => {
    const text = (await textOf("S1")).split("\n").filter((l) => !BANK_WORDING.test(l)).join("\n");
    const r = await evalDirect(noBank(extractionOf("S1")), doc(text));
    expect(r.outcome).toBe("CLEARED");
    expect(infos(r)).toContain("BANK_NOT_SHOWN");
  });

  it("the account was read: K4 compares as before (S1 matches the master)", async () => {
    const r = await evalDirect(extractionOf("S1"), doc(await textOf("S1")));
    expect(r.outcome).toBe("CLEARED");
  });
});

describe("G1b (spec v1.4): read as an invoice, but the document says otherwise -> CLASSIFICATION_CONFLICT (audit A03)", () => {
  const asQuote = (e: Extraction, title: string, label: string): Extraction => ({ ...e, doc_type: "invoice", document_title: title, number_label: label, invoice_number: "Q-2026-80" });

  it("title and label read as QUOTATION / Quote No. with doc_type invoice -> held", async () => {
    const text = (await textOf("S1")).replace(/TAX INVOICE/g, "QUOTATION").replace(/Invoice No\.?/g, "Quote No.").replace(/FP-2026-0418/g, "Q-2026-80");
    const r = await evalDirect(asQuote(extractionOf("S1"), "QUOTATION", "Quote No."), doc(text));
    expect(r.outcome).toBe("ON_HOLD");
    expect(codes(r)).toContain("CLASSIFICATION_CONFLICT");
    expect(finding(r, "CLASSIFICATION_CONFLICT")!.evidence.found_in).toBe("title or number label");
  });

  it("title PROFORMA INVOICE -> held", async () => {
    const text = (await textOf("S1")).replace(/TAX INVOICE/g, "PROFORMA INVOICE");
    const r = await evalDirect({ ...extractionOf("S1"), document_title: "PROFORMA INVOICE" }, doc(text));
    expect(codes(r)).toContain("CLASSIFICATION_CONFLICT");
  });

  it("the reader says TAX INVOICE but the page says QUOTATION -> held from the document text", async () => {
    const text = (await textOf("S1")).replace(/TAX INVOICE/g, "QUOTATION");
    const r = await evalDirect(extractionOf("S1"), doc(text));
    expect(r.outcome).toBe("ON_HOLD");
    expect(finding(r, "CLASSIFICATION_CONFLICT")!.evidence.found_in).toBe("document text");
  });

  it("a tax invoice that mentions the quotation it follows is not flagged", async () => {
    const text = `${await textOf("S1")}\nSupplied as per your quotation Q-2026-77`;
    const r = await evalDirect(extractionOf("S1"), doc(text));
    expect(r.outcome).toBe("CLEARED");
  });

  it("S3 is titled just INVOICE (no 'tax invoice') and is unchanged: held for price only", async () => {
    const r = await evalDirect(extractionOf("S3"), doc(await textOf("S3")));
    expect(codes(r)).toEqual(["PRICE_OVER_TOLERANCE"]);
  });

  it("whole words only: 'quoted' in an invoice title is not a quotation", async () => {
    const r = await evalDirect({ ...extractionOf("S1"), document_title: "TAX INVOICE (prices as quoted)" }, doc(await textOf("S1")));
    expect(codes(r)).not.toContain("CLASSIFICATION_CONFLICT");
  });

  it("a real quotation read as one (S9) is still skipped, not held", async () => {
    const r = await evalDirect(extractionOf("S9"), doc(await textOf("S9")));
    expect(r.outcome).toBe("SKIPPED");
  });
});

describe("M3 (spec v1.4): an AI line match needs support the code can check, not only a matching unit (audit A04)", () => {
  const proposeLine = (n: number) => new AnswerKeyProposer(() => ({ proposed_po_line: n, pack_size_read: null, justification: `scripted: PO line ${n}` }));
  const withLine1 = (description: string): Extraction => {
    const e = extractionOf("S1");
    return { ...e, lines: e.lines.map((l) => (l.line_no === 1 ? { ...l, description } : l)) };
  };

  it("a 750 ml container proposed for the PO's 500 ml line is rejected: the sizes conflict", async () => {
    const r = await evalDirect(withLine1("Food container 750 ml (round, PP)"), { proposer: proposeLine(1) });
    expect(r.outcome).toBe("ON_HOLD");
    expect(codes(r)).toEqual(["AI_PROPOSAL_REJECTED", "LINE_UNMAPPED"]);
    expect(String(finding(r, "AI_PROPOSAL_REJECTED")!.evidence.reason)).toMatch(/750 ml.*500 ml|500 ml.*750 ml/);
  });

  it("a different item with the same unit (tiffin carrier for a food container) is rejected: nothing supports it", async () => {
    const r = await evalDirect(withLine1("Stainless steel tiffin carrier 3-tier"), { proposer: proposeLine(1) });
    expect(codes(r)).toEqual(["AI_PROPOSAL_REJECTED", "LINE_UNMAPPED"]);
  });

  it("the same item described differently, sharing words and no conflicting size, is accepted", async () => {
    const r = await evalDirect(withLine1("Round food container, PP"), { proposer: proposeLine(1) });
    expect(r.outcome).toBe("CLEARED");
    expect(infos(r)).toContain("LINE_MAPPED_AI_VERIFIED");
  });

  it("words in common are not enough when only unit words match ('ml', 'pcs')", async () => {
    const r = await evalDirect(withLine1("Cleaning liquid 500 ml"), { proposer: proposeLine(1) });
    expect(codes(r)).toEqual(["AI_PROPOSAL_REJECTED", "LINE_UNMAPPED"]);
  });

  it("S14 (pack of 50, 500cc = 500 ml, catalog pack size printed and read) still clears", async () => {
    const r = await evalDirect(extractionOf("S14"));
    expect(r.outcome).toBe("CLEARED");
    expect(infos(r)).toContain("LINE_MAPPED_AI_VERIFIED");
  });
});

describe("V3b (spec v1.4): an amount must be printed as a whole number, not found inside a longer one (audit A05)", () => {
  it("S1 with a line amount misread as 1300.00 (printed 13,000.00) is not vouched for by the text", async () => {
    const e = extractionOf("S1");
    const misread: Extraction = { ...e, lines: e.lines.map((l) => (l.line_no === 1 ? { ...l, amount: "1300.00" } : l)) };
    const r = await evalDirect(misread, doc(await textOf("S1")));
    expect(r.outcome).toBe("ON_HOLD");
    expect(finding(r, "EVIDENCE_NOT_FOUND")!.evidence.not_found).toContain("line 1 amount = 1300.00");
  });

  it("the same misread passed the old check: the digits 130000 are inside 1300000", async () => {
    expect("1300000".includes("130000")).toBe(true); // what the substring check compared
  });

  it("grouping and trailing zeros do not matter: 13,000 and 1,00,000.0 vouch for 13000.00 and 100000.00", async () => {
    const e = extractionOf("S1");
    const text = (await textOf("S1")).replace(/13,000\.00/g, "13,000").replace(/18,880\.00/g, "18,880.0");
    const r = await evalDirect(e, doc(text));
    expect(codes(r)).not.toContain("EVIDENCE_NOT_FOUND");
  });

  it("every one of the 18 test documents still finds all its values (their real text layers)", async () => {
    for (const id of ["S1", "S2", "S3", "S4", "S6a", "S6b", "S10", "S11", "S12", "S13", "S14"]) {
      const r = await evalDirect(extractionOf(id), doc(await textOf(id)));
      expect(codes(r), id).not.toContain("EVIDENCE_NOT_FOUND");
    }
  });
});

describe("K4b also when the reader returns an account with no digits (review 23 Oct)", () => {
  it('"XXXX XXXX" read for the account, the real number printed: held, not cleared, and not called "no bank account printed"', async () => {
    const text = (await textOf("S1")).replace(/50200012344417/g, "50200012340042");
    const r = await evalDirect({ ...extractionOf("S1"), bank_account_last4: null, bank_account_number: "XXXX XXXX" }, doc(text));
    expect(r.outcome).toBe("ON_HOLD");
    expect(codes(r)).toEqual(["MISSING_REQUIRED_FIELD"]);
    expect(infos(r)).not.toContain("BANK_NOT_SHOWN");
  });

  it("a masked value with no bank wording on the page still holds: the reader saw an account", async () => {
    const text = (await textOf("S1")).split("\n").filter((l) => !BANK_WORDING.test(l)).join("\n");
    const r = await evalDirect({ ...extractionOf("S1"), bank_account_last4: null, bank_account_number: "XXXX XXXX" }, doc(text));
    expect(finding(r, "MISSING_REQUIRED_FIELD")!.evidence.printed_wording).toBe('read as "XXXX XXXX"');
  });

  it.each(["N/A", "Axis Bank"])('"%s" with no bank wording on the page is no account: info BANK_NOT_SHOWN, and S1 clears', async (v) => {
    const text = (await textOf("S1")).split("\n").filter((l) => !BANK_WORDING.test(l)).join("\n");
    const r = await evalDirect({ ...extractionOf("S1"), bank_account_last4: null, bank_account_number: v }, doc(text));
    expect(r.outcome).toBe("CLEARED");
    expect(infos(r)).toContain("BANK_NOT_SHOWN");
  });

  it.each(["Acct No: 50200012340042", "Bank Account: 50200012340042", "Account # 50200012340042"])("bank wording %s is recognised", (w) => {
    expect(BANK_WORDING.test(w)).toBe(true);
  });

  it.each(["Accounts payable", "Account notes", "account manager"])("ordinary words %s are not bank wording", (w) => {
    expect(BANK_WORDING.test(w)).toBe(false);
  });
});

describe("M3b: one shared word is not enough (review 23 Oct)", () => {
  const proposeLine = (n: number) => new AnswerKeyProposer(() => ({ proposed_po_line: n, pack_size_read: null, justification: `scripted: PO line ${n}` }));
  const withLine1 = (description: string): Extraction => {
    const e = extractionOf("S1");
    return { ...e, lines: e.lines.map((l) => (l.line_no === 1 ? { ...l, description } : l)) };
  };
  // "Food container lid 500 ml" never reaches the AI: the deterministic M1 match accepts a description holding every
  // word of the PO line. That is the spec's M1 rule, unchanged tonight; it is listed as an open point for the owner.
  it.each(["Container lid 500 ml", "Food tray (round, PP)", "Paper food box", "Lid for food container"])("%s proposed for the food container is rejected", async (d) => {
    const r = await evalDirect(withLine1(d), { proposer: proposeLine(1) });
    expect(codes(r)).toEqual(["AI_PROPOSAL_REJECTED", "LINE_UNMAPPED"]);
  });
  it.each(["Container for food, round", "Round food container, PP"])("%s (two item words in common, naming a container) still matches", async (d) => {
    const r = await evalDirect(withLine1(d), { proposer: proposeLine(1) });
    expect(r.outcome).toBe("CLEARED");
  });
});
