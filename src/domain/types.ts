import type { Paise } from "./money";

// Field names follow the test-data files (CSV headers, settings.json, email payloads).
// Amounts are paise; unit prices, quantities and rates stay exact decimal strings (A3).

export type { Extraction, ExtractionLine } from "./extraction-schema";

export interface Vendor {
  vendor_id: string;
  legal_name: string;
  aliases: string[];
  gstin: string | null;
  pan: string;
  bank_last4: string;
  payment_terms_days: number;
  registered_senders: string[];
  phone: string; // K4 evidence: "verify by phone using the vendor master number"
}

export interface CatalogItem {
  item_code: string;
  description: string;
  base_uom: string;
  pack_uom: string;
  pack_size: number;
}

export interface PoLine {
  po_number: string;
  line_no: number;
  item_code: string | null;
  line_kind: "goods" | "service" | "charge";
  description: string;
  uom: string;
  qty_ordered: string;
  unit_price_pretax: string;
  gst_rate: string;
  line_amount_pretax: Paise;
}

export interface PurchaseOrder {
  po_number: string;
  vendor_id: string;
  po_date: string;
  status: string;
  price_basis: string;
  subtotal_pretax: Paise;
  lines: PoLine[];
}

export interface Settings {
  price_tolerance_pct: number;
  quantity_tolerance_pct: number;
  rounding_tolerance_inr: number;
  approval_limit_inr: number;
  ap_forwarder_allowlist: string[];
  charge_keywords: string[];
  lump_sum_markers: { phrases: string[]; units: string[] };
  currency: string;
  buyer: { name: string; address: string[]; gstin: string };
  inbound_address_placeholder: string;
}

export interface InboundEmail {
  provider_email_id: string;
  attachment_id: string;
  from: string;
  to: string[];
  subject: string;
  body_text: string;
  attachments: { filename: string; path: string; content_type: string }[];
  /** DMARC result when the provider reports it (false = failed). Recorded test emails carry none. */
  sender_authenticated?: boolean | null;
}
