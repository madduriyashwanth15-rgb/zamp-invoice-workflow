import { z } from "zod";
import type { Settings } from "./types";

// Shape of answer_key.json expected_extraction plus optional buyer_gstin (spec 14).
// Decimals stay strings so no value passes through binary floating point (A3).
// Fields that V1 checks are nullable: a missing one is a MISSING_REQUIRED_FIELD hold, not a schema failure.
const decimal = (places: number) => z.string().regex(new RegExp(`^\\d+(\\.\\d{1,${places}})?$`));
const amount = decimal(2);

const line = z.object({
  line_no: z.number().int(),
  description: z.string(),
  hsn_sac: z.string().nullable(),
  qty: decimal(3).nullable(),
  uom: z.string().nullable(),
  unit_price: decimal(4).nullable(),
  amount,
  gst_rate: decimal(4).nullable(),
});

const extraction = z.object({
  doc_type: z.string().min(1),
  document_title: z.string().nullable(),
  number_label: z.string().nullable(),
  invoice_number: z.string().nullable(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  vendor_name: z.string().nullable(),
  vendor_gstin: z.string().nullable(),
  buyer_name: z.string().nullable(),
  buyer_gstin: z.string().nullable().optional(),
  po_reference: z.string().nullable(),
  price_basis: z.enum(["exclusive", "inclusive", "none"]),
  lines: z.array(line),
  subtotal: amount.nullable(),
  cgst: amount.nullable(),
  sgst: amount.nullable(),
  tax_total: amount.nullable(),
  total: amount.nullable(),
  bank_account_last4: z.string().regex(/^\d{4}$/).nullable(),
  revision_marker: z.boolean(),
  currency: z.string(),
});

export type Extraction = z.infer<typeof extraction>;
export type ExtractionLine = z.infer<typeof line>;

const gstin = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

/** A vendor_gstin equal to the buyer's own GSTIN is schema-invalid (A14). */
export function extractionSchema(settings: Settings) {
  return extraction.refine((e) => !e.vendor_gstin || gstin(e.vendor_gstin) !== gstin(settings.buyer.gstin), {
    path: ["vendor_gstin"],
    message: "vendor_gstin equals the buyer's own GSTIN",
  });
}
