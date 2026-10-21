import { readFileSync } from "node:fs";
import path from "node:path";
import { toPaise } from "@/domain/money";
import type { CatalogItem, InboundEmail, PoLine, PurchaseOrder, Settings, Vendor } from "@/domain/types";

export const TEST_DATA_DIR = path.resolve("zamp-ps1-test-data-v2.1", "test-data");

const read = (dir: string, name: string) => readFileSync(path.join(dir, name), "utf-8");

/** RFC 4180 subset: quoted fields with commas and "" escapes; CRLF or LF. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else field += c;
  }
  if (field || row.length) endRow();
  const [header, ...body] = rows.filter((r) => r.some(Boolean));
  return body.map((r) => {
    if (r.length !== header.length) throw new Error(`CSV row has ${r.length} fields, header has ${header.length}`);
    return Object.fromEntries(header.map((h, j) => [h, r[j]]));
  });
}

const list = (s: string) => s.split("|").map((x) => x.trim()).filter(Boolean);

export function loadReferenceData(dir = TEST_DATA_DIR) {
  const vendors: Vendor[] = parseCsv(read(dir, "vendors.csv")).map((r) => ({
    vendor_id: r.vendor_id,
    legal_name: r.legal_name,
    aliases: list(r.aliases),
    gstin: r.gstin || null,
    pan: r.pan,
    bank_last4: r.bank_last4,
    payment_terms_days: Number(r.payment_terms_days),
    registered_senders: list(r.registered_senders),
    phone: r.phone,
  }));
  const catalog: CatalogItem[] = parseCsv(read(dir, "catalog.csv")).map((r) => ({
    item_code: r.item_code,
    description: r.description,
    base_uom: r.base_uom,
    pack_uom: r.pack_uom,
    pack_size: Number(r.pack_size),
  }));
  const lines: PoLine[] = parseCsv(read(dir, "po_lines.csv")).map((r) => ({
    po_number: r.po_number,
    line_no: Number(r.line_no),
    item_code: r.item_code || null,
    line_kind: r.line_kind as PoLine["line_kind"],
    description: r.description,
    uom: r.uom,
    qty_ordered: r.qty_ordered,
    unit_price_pretax: r.unit_price_pretax,
    gst_rate: r.gst_rate,
    line_amount_pretax: toPaise(r.line_amount_pretax),
  }));
  const purchaseOrders: PurchaseOrder[] = parseCsv(read(dir, "purchase_orders.csv")).map((r) => ({
    po_number: r.po_number,
    vendor_id: r.vendor_id,
    po_date: r.po_date,
    status: r.status,
    price_basis: r.price_basis,
    subtotal_pretax: toPaise(r.subtotal_pretax),
    lines: lines.filter((l) => l.po_number === r.po_number),
  }));
  const settings: Settings = JSON.parse(read(dir, "settings.json"));
  return { vendors, catalog, purchaseOrders, settings };
}

export interface AnswerKeyTest {
  test_id: string;
  email_payload: string;
  expected_extraction: unknown; // validated by extractionSchema where used
  expected: { outcome: string; blocking: string[]; info: string[]; side_effects: unknown[] };
  [key: string]: unknown;
}

export function loadAnswerKey(dir = TEST_DATA_DIR): { version: string; tests: AnswerKeyTest[] } {
  return JSON.parse(read(dir, "answer_key.json"));
}

/** Recorded email payload with each {{TOKEN:<id>}} replaced by the token issued for that run. */
export function loadEmail(testId: string, tokens: Record<string, string> = {}, dir = TEST_DATA_DIR): InboundEmail {
  const raw = read(dir, path.join("emails", `${testId}.json`)).replace(/\{\{TOKEN:([^}]+)\}\}/g, (_, id: string) => {
    if (!tokens[id]) throw new Error(`${testId}: no token issued for ${id}`);
    return tokens[id];
  });
  const { provider_email_id, attachment_id, from, to, subject, body_text, attachments } = JSON.parse(raw);
  return { provider_email_id, attachment_id, from, to, subject, body_text, attachments };
}
