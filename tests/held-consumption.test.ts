import { describe, expect, it } from "vitest";
import type { ReferenceData } from "@/domain/engine/types";
import type { Extraction } from "@/domain/extraction-schema";
import { ingest, type ExtractionAttempt, type Extractor, type ExtractorInput, type PipelineDeps } from "@/domain/runs/pipeline";
import { overrideApprove } from "@/domain/runs/review";
import { extractionOf, textFrom } from "./support/direct";
import { makeDeps, reference } from "./support/harness";

// Review 23 Oct: a held line that a reviewer approves must count on the PO line it bills, so the per-line caps
// (M7 charge amount, C2 quantity) see it. MOCK reading (scripted); pipeline, engine and review are the real code.

class Scripted implements Extractor {
  readonly label = "MOCK scripted reading";
  constructor(private docs: Map<string, Extraction>) {}
  async extract(i: ExtractorInput): Promise<ExtractionAttempt> {
    return { status: "ok", extraction: structuredClone(this.docs.get(i.filename)!), attempts: 1, label: this.label };
  }
}

/** PO-1001 with an approved delivery charge of 500.00 (the test data has no charge lines). */
function withDeliveryLine(): ReferenceData {
  const ref = structuredClone(reference);
  const po = ref.purchaseOrders.find((p) => p.po_number === "PO-1001")!;
  po.lines.push({ po_number: "PO-1001", line_no: 3, item_code: null, line_kind: "charge", description: "Delivery charges", uom: "job", qty_ordered: "1", unit_price_pretax: "500.00", gst_rate: "0.18", line_amount_pretax: 50_000n });
  po.subtotal_pretax += 50_000n;
  return ref;
}

const delivery = (amount: string) => ({ line_no: 3, description: "Delivery charges", hsn_sac: null, qty: "1", uom: "job", unit_price: amount, amount, gst_rate: "0.18" });

describe("held lines count on their PO line once approved", () => {
  it("an over-cap delivery charge approved by exception uses up the PO's delivery line, so a second one is held", async () => {
    const docs = new Map<string, Extraction>();
    const deps: PipelineDeps = { ...makeDeps(), reference: withDeliveryLine(), extractor: new Scripted(docs) };
    const send = (name: string, e: Extraction) => {
      docs.set(name, e);
      return ingest(deps, {
        source: "email", sender_email: "billing@freshpack.example", uploader_display_name: null, provider_email_id: `p-${name}`, attachment_id: "a",
        filename: name, content_type: "application/pdf", bytes: new Uint8Array([name.length]), subject: "Invoice", reply_token: null,
        text_layer: textFrom(e), has_text_layer: true,
      });
    };
    const s1 = extractionOf("S1");
    const first: Extraction = {
      ...s1, invoice_number: "FP-2026-0501", lines: [...s1.lines, delivery("800.00")],
      subtotal: "16800.00", cgst: "1512.00", sgst: "1512.00", tax_total: "3024.00", total: "19824.00",
    };
    const a = await send("a.pdf", first);
    expect(a.blocking_codes).toEqual(["UNAPPROVED_CHARGE"]);
    expect(a.consumption.find((c) => c.line_no === 3)?.amount_paise).toBe(80_000n);
    expect((await overrideApprove(deps, a.run_id, { actor: "Divya (AP)", note: "Express delivery agreed by phone" })).ok).toBe(true);

    const second: Extraction = {
      ...s1, invoice_number: "FP-2026-0502", lines: [{ ...delivery("500.00"), line_no: 1 }],
      subtotal: "500.00", cgst: "45.00", sgst: "45.00", tax_total: "90.00", total: "590.00",
    };
    const b = await send("b.pdf", second);
    expect(b.blocking_codes).toContain("UNAPPROVED_CHARGE"); // before the fix: CLEARED, ₹1,300 of delivery against ₹500 on the PO
  });
});
