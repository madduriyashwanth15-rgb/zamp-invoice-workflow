import type { Settings } from "@/domain/types";

// Versioned prompts (spec 14). Bump the version whenever the text changes: it is part of the cache key.

export const EXTRACTION_PROMPT_VERSION = "extract-v2";
export const MAPPING_PROMPT_VERSION = "map-v1";

export function extractionPrompt(settings: Settings): string {
  return `You read one purchase invoice for ${settings.buyer.name} (the buyer, GSTIN ${settings.buyer.gstin}) and return JSON only.

Copy values exactly as printed. Never compute, correct or round anything: if the printed total is wrong, return the printed total.
If a value is not printed, return null. Never guess a value.

Return exactly this JSON object:
{
  "doc_type": one of "invoice", "credit_note", "quotation", "statement", "other",
  "document_title": the title as printed (e.g. "TAX INVOICE", "QUOTATION") or null,
  "number_label": the label printed before the document number (e.g. "Invoice No.", "Bill No.", "Quote No.") or null,
  "invoice_number": the document number exactly as printed, or null,
  "invoice_date": the document date as YYYY-MM-DD (Indian invoices print day first: 15/10/2026 is 2026-10-15), or null,
  "vendor_name": the SELLER's name (the business issuing the document), or null,
  "vendor_gstin": the SELLER's GSTIN, or null. Never return the buyer's GSTIN ${settings.buyer.gstin} here,
  "buyer_name": the buyer's name as printed, or null,
  "buyer_gstin": the buyer's GSTIN as printed, or null,
  "po_reference": the purchase order number exactly as printed (e.g. "PO-1001", "7731"), or null if no PO is printed,
  "price_basis": "exclusive" if tax is added on top of the line amounts, "inclusive" if the document states prices include GST,
                 "none" if no tax applies, or null if the document does not make it clear,
  "lines": [ { "line_no": integer from 1, "description": as printed, "hsn_sac": string or null,
               "qty": decimal string or null, "uom": unit as printed or null, "unit_price": decimal string or null,
               "amount": decimal string, "gst_rate": decimal fraction string such as "0.18" for 18% (CGST 9% + SGST 9%), "0" if no tax, or null } ],
  "subtotal": decimal string or null (for inclusive documents: the taxable value),
  "cgst": decimal string or null, "sgst": decimal string or null, "igst": decimal string or null,
  "tax_total": the total GST only if it is printed as its own line (e.g. "Total GST", "Total Tax"), else null.
               Do not add CGST and SGST yourself,
  "total": the grand total as printed, decimal string or null,
  "bank_account_last4": the LAST 4 digits of the printed bank account number, or null if no account is printed,
  "revision_marker": true if the document is marked revised or corrected, else false,
  "currency": "INR"
}

Decimal strings use a dot and no thousands separators: "18880.00", "6.50", "3.045".`;
}

export function retryFeedback(errors: string[]): string {
  return `Your previous answer was rejected by validation: ${errors.slice(0, 8).join("; ")}. Return the corrected JSON object only.`;
}

export function mappingPrompt(input: {
  description: string; qty: string | null; uom: string | null; unit_price: string | null;
  candidates: { line_no: number; description: string; uom: string; item_code: string | null }[];
  catalog: { item_code: string; description: string; base_uom: string; pack_uom: string; pack_size: number }[];
}): string {
  return `An invoice line could not be matched to a purchase-order line by exact wording. Propose which PO line it is, or none.
You only propose: code will verify units and pack sizes and compare prices itself.

Invoice line: ${JSON.stringify({ description: input.description, qty: input.qty, uom: input.uom, unit_price: input.unit_price })}
PO lines: ${JSON.stringify(input.candidates)}
Catalog (unit conversions): ${JSON.stringify(input.catalog)}

Return JSON only: {"proposed_po_line": PO line_no or null, "pack_size_read": the pack size printed in the invoice description as an integer, or null, "justification": one short sentence}.
If no PO line is clearly the same item, return null for proposed_po_line.`;
}
