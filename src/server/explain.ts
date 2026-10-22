import Decimal from "decimal.js";
import { REASON_CODES, SEVERITY, type ReasonCode } from "@/domain/codes";
import type { Finding, LineMatch, ReferenceData } from "@/domain/engine/types";
import { vendorFixable, type ActionOption, type ReviewAction } from "@/domain/runs/queries";
import type { AuditEvent, RunRecord } from "@/domain/runs/types";
import { formatDate, formatInr } from "@/lib/format";
import { CODE_TEXT, STATE_TEXT } from "@/lib/reason-text";

// Plain-language explanations of a run's holds (audit U01, U03-U05). Presentation only: every sentence is built
// from the engine's recorded evidence and the reference data; nothing here decides anything or changes state.
//
// Three readers: the reviewer (what was found, with the numbers, and what to do), the vendor (the correction email:
// only what they can fix, no rule codes, nothing about our own checks), and the action bar (which button to lead with).

export interface IssueView {
  /** Main code first; a paired code on the same line (an AI match rejected, so the line is unmatched) follows. */
  codes: ReasonCode[];
  title: string;
  /** What was found, with the figures. */
  explain: string;
  /** What the reviewer can do about it, limited to the actions offered now; null outside ON_HOLD. */
  next: string | null;
  line_no: number | null;
  /** A corrected invoice from the vendor can fix it. */
  vendor_fixable: boolean;
}

export interface Recommended {
  action: ReviewAction;
  why: string;
}

export interface ExplainContext {
  run: RunRecord;
  ref: ReferenceData;
  /** Names another run by its reference (A0003) rather than its id. */
  refOf: (runId: string) => string;
  /** Runs holding the same invoice number with different content (for RELATED_INVOICE_DISPUTE). */
  disputedBy?: RunRecord[];
  /** The reviewer's note when they put it on hold (MANUAL_HOLD). */
  holdNote?: string | null;
  /** Actions offered now; the advice only names these. Omitted for the vendor email. */
  actions?: ActionOption[];
}

// ---- formatting helpers (decimal strings only; no money through floating point)

const inr = (v: unknown): string => (v == null || v === "" ? "an amount not read" : formatInr(String(v)) ?? String(v));

/** Unit prices keep up to 4 decimals ("₹0.8333"); whole-paisa prices show 2 ("₹40.00"). */
export function unitInr(v: unknown): string {
  if (v == null || v === "") return "a price not read";
  const d = new Decimal(String(v)).toDecimalPlaces(4);
  const dp = Math.max(2, d.decimalPlaces());
  const [i, f] = d.abs().toFixed(dp).split(".");
  return `${d.isNeg() ? "-" : ""}${formatInr(i)!.replace(/\.00$/, "")}.${f}`;
}

/** "0.18" -> "18%". */
const ratePct = (rate: unknown) => (rate == null ? "an unread rate" : `${new Decimal(String(rate)).mul(100).toDecimalPlaces(2).toString()}%`);
const num = (v: unknown) => (v == null ? "?" : new Decimal(String(v)).toDecimalPlaces(4).toString());
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const quoteDesc = (d: string | null | undefined) => (d ? ` "${d}"` : "");

/** Who read the document, for sentences like "The AI read it as...": a MOCK run must not claim AI work (U12). */
export function readerName(run: RunRecord): string {
  const label = run.extracted_by?.extractor ?? "";
  return /gemini/i.test(label) ? "The AI" : /mock/i.test(label) ? "The MOCK reading" : "The reading";
}

/** Who proposed a line match (M2): the AI on a Gemini run, the scripted MOCK proposer otherwise. */
function proposerName(run: RunRecord): string {
  const r = readerName(run);
  return r === "The AI" ? "The AI" : r === "The MOCK reading" ? "The MOCK proposer" : "The line proposer";
}

interface Facts {
  ctx: ExplainContext;
  po: string;
  vendorName: string;
  phone: string | null;
  match: (line?: number) => LineMatch | undefined;
  desc: (line?: number) => string | null;
  poLineDesc: (poLine: unknown) => string | null;
  poUom: (line?: number, poLine?: unknown) => string | null;
}

function factsOf(ctx: ExplainContext): Facts {
  const { run, ref } = ctx;
  const vendor = run.vendor_id ? ref.vendors.find((v) => v.vendor_id === run.vendor_id) : undefined;
  const po = ref.purchaseOrders.find((p) => p.po_number === run.po_number);
  const matches = run.engine?.line_matches ?? [];
  const match = (line?: number) => (line == null ? undefined : matches.find((m) => m.invoice_line === line));
  const poLineOf = (n: unknown) => po?.lines.find((l) => String(l.line_no) === String(n));
  return {
    ctx,
    po: run.po_number ?? "the PO",
    vendorName: vendor?.legal_name ?? run.extraction?.vendor_name ?? "the vendor",
    phone: vendor?.phone ?? null,
    match,
    desc: (line) => match(line)?.description ?? run.extraction?.lines.find((l) => l.line_no === line)?.description ?? null,
    poLineDesc: (n) => poLineOf(n)?.description ?? null,
    poUom: (line, n) => match(line)?.po_uom ?? poLineOf(n ?? match(line)?.po_line)?.uom ?? null,
  };
}

const ARITHMETIC_CHECKS: [RegExp, (c: string, p: string, m: RegExpExecArray) => string][] = [
  [/^line (\d+) amount = qty x unit price$/, (c, p, m) => `Line ${m[1]}: quantity times unit price is ${c}, but the amount printed is ${p}`],
  [/^sum of lines = subtotal$/, (c, p) => `The lines add up to ${c}, but the subtotal printed is ${p}`],
  [/^sum of \(line amount x GST rate\) = tax$/, (c, p) => `GST on the lines works out to ${c}, but the tax printed is ${p}`],
  [/^CGST \+ SGST \(or IGST\) = tax$/, (c, p) => `CGST and SGST (or IGST) add up to ${c}, but the tax printed is ${p}`],
  [/^subtotal \+ tax = total$/, (c, p) => `Subtotal plus tax is ${c}, but the total printed is ${p}`],
  [/^sum of lines = total$/, (c, p) => `The lines add up to ${c}, but the total printed is ${p}`],
  [/^total \/ \(1 \+ rate\) = taxable value$/, (c, p) => `The total without GST is ${c}, but the taxable value printed is ${p}`],
  [/^taxable value \+ tax = total$/, (c, p) => `Taxable value plus tax is ${c}, but the total printed is ${p}`],
  [/^tax = 0$/, (_c, p) => `No GST applies at this basis, but ${p} of tax is printed`],
];

function arithmeticSentence(check: unknown, computed: unknown, printed: unknown): string | null {
  if (check == null) return null;
  const c = inr(computed);
  const p = inr(printed);
  for (const [re, text] of ARITHMETIC_CHECKS) {
    const m = re.exec(String(check));
    if (m) return text(c, p, m);
  }
  return `${cap(String(check))}: expected ${c}, printed ${p}`;
}

/** The engine message without its rule tag ("... (V2)"), for the few cases where it is already plain. */
const untagged = (message: string) => message.replace(/\s*\([^)]*\)\s*$/, "");

const MISSING_WORDS: Record<string, string> = {
  "invoice number": "an invoice number", "invoice date": "an invoice date", "vendor identity": "your company name or GSTIN",
  "at least one line": "any item lines", total: "a total",
};

/** Reviewer sentence for one finding. */
function explainFinding(f: Finding, x: Facts): string {
  const e = f.evidence;
  const n = f.line_no;
  const m = x.match(n);
  const d = x.desc(n);
  const lineName = n != null ? `Line ${n}${d ? ` "${d}"` : ""}` : "";
  const run = x.ctx.run;
  switch (f.code) {
    case "PRICE_OVER_TOLERANCE":
    case "PRICE_BELOW_PO":
    case "PRICE_WITHIN_TOLERANCE": {
      const uom = x.poUom(n) ?? "unit";
      const price = m?.price_per_po_unit ?? e.invoice_price_per_base_unit;
      const poPrice = m?.po_unit_price ?? e.po_price;
      const where = m?.po_line != null ? `${x.po} line ${m.po_line}` : x.po;
      let s = `${lineName}: ${unitInr(price)} per ${uom} before GST, against ${unitInr(poPrice)} on ${where}. That is ${num(e.difference_pct)}% ${f.code === "PRICE_BELOW_PO" ? "less" : "more"}; the tolerance is ${num(e.tolerance_pct)}%.`;
      // Exact extra cost only where the line amount is pre-tax as printed (exclusive or no GST).
      if (f.code === "PRICE_OVER_TOLERANCE" && m?.base_qty && m.po_unit_price && (e.basis === "exclusive" || e.basis === "none")) {
        const extra = new Decimal(m.amount).minus(new Decimal(m.base_qty).mul(m.po_unit_price)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        if (extra.gt(0)) s += ` On ${num(m.base_qty)} ${uom} that is ${inr(extra.toFixed(2))} above the PO price.`;
      }
      return s;
    }
    case "QTY_EXCEEDS_PO": {
      const uom = x.poUom(n, e.po_line) ?? "units";
      const already = new Decimal(String(e.already_billed ?? 0));
      const tol = x.ctx.ref.settings.quantity_tolerance_pct;
      return `${lineName}: ${num(e.invoiced)} ${uom} billed now${already.gt(0) ? ` and ${num(already)} already billed` : ""}, against ${num(e.ordered)} ordered on ${x.po} line ${e.po_line}${tol > 0 ? ` (tolerance ${tol}%)` : ""}.`;
    }
    case "PO_AMOUNT_EXCEEDED": {
      if (e.po_remaining != null) {
        return `${lineName} is billed as a lump sum of ${inr(e.amount)} before GST, more than the ${inr(e.po_remaining)} that remains on ${x.po} (PO value ${inr(e.po_subtotal)} before GST).`;
      }
      const already = new Decimal(String(e.already_billed ?? 0));
      const sum = new Decimal(String(e.invoiced_pretax ?? 0)).plus(already).toFixed(2);
      return `${inr(e.invoiced_pretax)} on this invoice${already.gt(0) ? ` plus ${inr(e.already_billed)} already billed` : ""} comes to ${inr(sum)} before GST, above the ${inr(e.cap)} allowed on ${x.po} (PO value ${inr(e.po_subtotal)} plus ${x.ctx.ref.settings.price_tolerance_pct}%).`;
    }
    case "ARITHMETIC_MISMATCH":
      return `${arithmeticSentence(e.check, e.computed, e.printed) ?? untagged(f.message)}.`;
    case "TAX_BASIS_UNCLEAR": {
      const why = /^Price basis unclear: (.*?)(?: \(T3\))?$/.exec(f.message)?.[1];
      return `It is not clear whether the prices include GST${why ? `: ${why}` : ""}.`;
    }
    case "TAX_RATE_MISMATCH":
      return `${lineName}: GST is charged at ${ratePct(e.invoice_rate)}, but ${x.po} has ${ratePct(e.po_rate)}.`;
    case "MISSING_REQUIRED_FIELD":
      if (e.field === "bank account") {
        return /^read as /.test(String(e.printed_wording))
          ? `A bank account appears on the document (${e.printed_wording}), but no account number was read, so it was not compared with the account on file (ending ${e.master_last4}).`
          : `A bank account is printed ("${e.printed_wording}"), but it was not read, so it was not compared with the account on file (ending ${e.master_last4}).`;
      }
      return `Not found on the invoice as read: ${list(strs(e.missing))}.`;
    case "EVIDENCE_NOT_FOUND": {
      const missing = strs(e.not_found);
      return `${missing.length} of ${e.searched} values read could not be found in the document's text: ${list(missing)}.`;
    }
    case "SCAN_UNVERIFIED":
      return "There is no text layer (a scan or a photo), so no value read could be checked against the document's own text.";
    case "DATE_INVALID":
      return `The invoice is dated ${formatDate(String(e.invoice_date))}, after today (${formatDate(String(e.today))}).`;
    case "APPROVAL_LIMIT_EXCEEDED":
      return `The total, ${inr(e.total)}, is above the ${inr(e.limit)} approval limit.`;
    case "UNAPPROVED_CHARGE": {
      if (e.po_amount == null) {
        return `${lineName} is a charge of ${inr(e.amount)} before GST, and ${x.po} has no charge line for it.`;
      }
      const already = new Decimal(String(e.already_billed ?? 0));
      return `${lineName}: ${inr(e.amount)} before GST${already.gt(0) ? ` plus ${inr(e.already_billed)} already billed` : ""} is more than the ${inr(e.po_amount)} ${x.po} allows for this charge.`;
    }
    case "BUNDLED_QUANTITY_UNVERIFIED":
      return `${lineName} is billed as a lump sum of ${inr(e.amount)} before GST, so there is no quantity to check against ${x.po}.`;
    case "LINE_UNMAPPED":
      if (e.earlier_invoice_line != null) {
        return `Line ${n} matches ${x.po} line ${e.po_line}, which invoice line ${e.earlier_invoice_line} already bills; one PO line is billed once per invoice.`;
      }
      if (/no quantity or unit price/.test(f.message)) return `Line ${n} matches ${x.po} line ${e.po_line}, but it has no quantity or unit price to compare.`;
      return `${lineName} does not match any line on ${x.po}.`;
    case "UOM_UNSUPPORTED":
      return `${lineName} is billed in ${e.invoice_unit ?? "no unit"} and the PO line is in ${e.po_unit}; the conversion could not be verified${e.reason ? ` (${e.reason})` : ""}.`;
    case "AI_PROPOSAL_REJECTED": {
      const poDesc = (e.po_line as string | undefined) ?? x.poLineDesc(e.proposed_po_line);
      return `${proposerName(run)} matched line ${n}${d ? ` "${d}"` : ""} to ${x.po} line ${e.proposed_po_line}${quoteDesc(poDesc)}, but the code did not accept it: ${e.reason}. The line stays unmatched.`;
    }
    case "PO_NOT_FOUND": {
      if (e.reference != null) return `The PO printed, ${e.reference}, is not one of our purchase orders.`;
      const open = strs(e.open_pos);
      return `No PO is printed, and ${open.length ? `none of ${x.vendorName}'s open POs (${list(open)}) covers every line` : `${x.vendorName} has no open PO`}.`;
    }
    case "PO_AMBIGUOUS":
      return `No PO is printed, and ${list(strs(e.fitting))} could each be it. The code does not guess.`;
    case "PO_VENDOR_MISMATCH": {
      const owner = x.ctx.ref.vendors.find((v) => v.vendor_id === e.owner)?.legal_name ?? String(e.owner);
      return `${e.po} belongs to ${owner}, not ${x.vendorName}.`;
    }
    case "PO_CLOSED":
      return `${e.po} is ${String(e.status).toLowerCase()}, so nothing more can be billed against it.`;
    case "VENDOR_UNKNOWN":
      return `"${e.vendor_name ?? "Unnamed vendor"}"${e.vendor_gstin ? ` (GSTIN ${e.vendor_gstin})` : ""} is not in the vendor master, so its bank account, purchase orders and prices could not be checked.`;
    case "VENDOR_GSTIN_MISMATCH":
      return `The GSTIN printed is ${e.printed}; the vendor master has ${e.master} for ${x.vendorName}.`;
    case "SENDER_UNVERIFIED":
      if (e.authentication === "failed") return `The email from ${e.sender} failed sender authentication (DMARC), so it may not have come from ${x.vendorName}.`;
      return `${e.sender} is not an address registered for ${x.vendorName}${strs(e.registered_senders).length ? ` (registered: ${list(strs(e.registered_senders))})` : ""}.`;
    case "BANK_DETAILS_CHANGED":
      return `The invoice asks for payment to an account ending ${e.printed_last4}; the vendor master has the account ending ${e.master_last4}.`;
    case "POSSIBLE_DOUBLE_BILLING": {
      const earlier = x.ctx.refOf(String(e.earlier_run));
      if (e.this_total != null) {
        const state = STATE_TEXT[e.earlier_state as RunRecord["state"]]?.label.toLowerCase() ?? String(e.earlier_state);
        return `${earlier}${e.earlier_vendor_matched === false ? ", whose vendor was not matched to the vendor master," : ""} has the same ${e.same === "date and total" ? "date and total" : "invoice number"} and is already ${state}${e.earlier_exported ? " and exported" : ""}: ${inr(e.earlier_total)} dated ${formatDate(String(e.earlier_date))}. This one is ${inr(e.this_total)} dated ${formatDate(String(e.this_date))}.`;
      }
      if (e.earlier_state === "REJECTED") return `${earlier} had the same invoice number and was rejected; this one has different content.`;
      return `Clearing this would leave two payable invoices with the same number (${earlier}).`;
    }
    case "CORRECTION_UNCONFIRMED":
      return `It looks like a corrected copy of ${list(strs(e.earlier_runs).map(x.ctx.refOf))}, but it was not linked automatically: ${e.reason}.`;
    case "POSSIBLE_DUPLICATE":
      return `${x.ctx.refOf(String(e.earlier_run))} has a different invoice number but the same vendor, date (${formatDate(String(e.invoice_date))}) and total (${inr(e.total)}).`;
    case "CLASSIFICATION_CONFLICT":
      if (e.word != null && e.doc_type !== "invoice") return `${readerName(run)} read it as ${String(e.doc_type).replace(/_/g, " ")}, and its ${e.found_in} says "${e.word}": not a tax invoice.`;
      if (e.word != null) return `It was read as an invoice, but the ${e.found_in} says "${e.word}", which is not a tax invoice.`;
      return `${readerName(run)} read it as ${String(e.doc_type).replace(/_/g, " ")}, but its ${e.title ? `title "${e.title}"` : `number label "${e.number_label}"`} says invoice.`;
    case "CREDIT_NOTE_UNSUPPORTED":
      return `It is a credit note${e.title ? ` ("${e.title}")` : ""}; credit notes are not approved for the payment list here.`;
    case "NOT_INVOICE":
      return `${readerName(run)} read it as ${String(e.doc_type).replace(/_/g, " ")}${e.title ? `, titled "${e.title}"` : ""}, with no invoice title or number label, so it was not processed.`;
    case "DUPLICATE_INVOICE":
      return `${x.ctx.refOf(String(e.earlier_run))} has the same vendor, invoice number, date (${formatDate(String(e.invoice_date))}) and total (${inr(e.total)}), so this repeat was rejected automatically.`;
    default:
      return untagged(f.message);
  }
}

/** Vendor sentence for one finding, or null when it is not theirs to fix (or a paired finding already says it). */
function vendorSentence(f: Finding, x: Facts): string | null {
  if (!vendorFixable(f)) return null;
  const e = f.evidence;
  const n = f.line_no;
  const d = x.desc(n);
  const lineName = n != null ? `Line ${n}${d ? ` "${d}"` : ""}` : "";
  const m = x.match(n);
  switch (f.code) {
    case "PRICE_OVER_TOLERANCE": {
      const uom = x.poUom(n) ?? "unit";
      return `${lineName} works out to ${unitInr(m?.price_per_po_unit ?? e.invoice_price_per_base_unit)} per ${uom} before GST; purchase order ${x.po} agreed ${unitInr(m?.po_unit_price ?? e.po_price)}.`;
    }
    case "QTY_EXCEEDS_PO": {
      const uom = x.poUom(n, e.po_line) ?? "units";
      const already = new Decimal(String(e.already_billed ?? 0));
      const left = Decimal.max(0, new Decimal(String(e.ordered)).minus(already));
      return `${lineName} bills ${num(e.invoiced)} ${uom}, but ${num(left)} ${uom} remain on purchase order ${x.po} (${num(e.ordered)} ordered${already.gt(0) ? `, ${num(already)} already invoiced` : ""}).`;
    }
    case "PO_AMOUNT_EXCEEDED": {
      if (e.po_remaining != null) return `${lineName} bills a lump sum of ${inr(e.amount)} before GST, more than the ${inr(e.po_remaining)} remaining on purchase order ${x.po}.`;
      const sum = new Decimal(String(e.invoiced_pretax ?? 0)).plus(String(e.already_billed ?? 0)).toFixed(2);
      return `This invoice brings the amount billed on purchase order ${x.po} to ${inr(sum)} before GST, above the order value of ${inr(e.po_subtotal)}.`;
    }
    case "ARITHMETIC_MISMATCH": {
      const s = arithmeticSentence(e.check, e.computed, e.printed);
      return s ? `${s}.` : "The line amounts, tax and total do not add up.";
    }
    case "TAX_BASIS_UNCLEAR":
      return "It is not clear whether the prices include GST. Please state it, with the GST shown separately.";
    case "TAX_RATE_MISMATCH":
      return `${lineName} charges GST at ${ratePct(e.invoice_rate)}; purchase order ${x.po} has ${ratePct(e.po_rate)}.`;
    case "MISSING_REQUIRED_FIELD":
      return `The invoice does not show ${list(strs(e.missing).map((w) => MISSING_WORDS[w] ?? w))}.`;
    case "PO_NOT_FOUND":
      return e.reference != null
        ? `The purchase order number on the invoice, ${e.reference}, does not match an order we placed with you.`
        : "The invoice does not show a purchase order number.";
    case "PO_AMBIGUOUS":
      return "The invoice does not show a purchase order number, and more than one of our open orders with you could match.";
    case "PO_VENDOR_MISMATCH":
      return `Purchase order ${e.po} on the invoice is not an order placed with you.`;
    case "PO_CLOSED":
      return `Purchase order ${e.po} is ${String(e.status).toLowerCase()} and cannot be billed.`;
    case "UNAPPROVED_CHARGE":
      return e.po_amount == null
        ? `${lineName} for ${inr(e.amount)} before GST is not on purchase order ${x.po}. Please remove it, or tell us who approved it.`
        : `${lineName} bills ${inr(e.amount)} before GST; purchase order ${x.po} allows ${inr(e.po_amount)} for it${new Decimal(String(e.already_billed ?? 0)).gt(0) ? `, and ${inr(e.already_billed)} has already been invoiced` : ""}.`;
    case "DATE_INVALID":
      return `The invoice is dated ${formatDate(String(e.invoice_date))}, which is in the future.`;
    case "SCAN_UNVERIFIED":
      return "We received a scanned image, which we cannot verify. Please send the invoice as a digital PDF.";
    case "BUNDLED_QUANTITY_UNVERIFIED":
      return `${lineName} is billed as a lump sum. Please show the quantity and unit price for each item.`;
    case "LINE_UNMAPPED":
      if (e.earlier_invoice_line != null) return `Line ${n} bills the same purchase-order item as line ${e.earlier_invoice_line}.`;
      if (/no quantity or unit price/.test(f.message)) return `${lineName} has no quantity or unit price.`;
      return `${lineName} is not an item on purchase order ${x.po}. Please check the description.`;
    case "UOM_UNSUPPORTED":
      return `${lineName} is billed in ${e.invoice_unit ?? "no unit"}, but purchase order ${x.po} is in ${e.po_unit}. Please bill in ${e.po_unit} or state the pack size.`;
    case "CLASSIFICATION_CONFLICT":
      return `The document is marked "${e.word}". Please send the tax invoice.`;
    default:
      return null;
  }
}

// ---- what the reviewer can do: each piece of advice is tied to an action, and only offered actions are named

type Advice = { before?: string; options: [ReviewAction | null, string][] };

const PHONE_CHECK = (x: Facts) =>
  x.phone
    ? `Call ${x.vendorName} on ${x.phone} (vendor master) to confirm. Never use a number printed on the invoice or in the email.`
    : "Confirm with the vendor using a number you already trust, never one from the invoice or the email.";

function adviceFor(issue: { code: ReasonCode; finding?: Finding }, x: Facts): Advice {
  const e = issue.finding?.evidence ?? {};
  const fix = (t: string): [ReviewAction, string] => ["request_correction", t];
  const override = (t: string): [ReviewAction, string] => ["override_approve", t];
  const reject = (t: string): [ReviewAction, string] => ["reject", t];
  switch (issue.code) {
    case "PRICE_OVER_TOLERANCE":
      return { options: [fix("ask the vendor to bill at the PO price"), override("approve with an exception if the higher price was agreed")] };
    case "QTY_EXCEEDS_PO":
      return { options: [fix("ask the vendor to bill only what remains on the PO"), override("approve with an exception if the extra quantity was agreed")] };
    case "PO_AMOUNT_EXCEEDED":
      return { options: [fix("ask the vendor for an invoice within the PO value"), override("approve with an exception if the PO is being increased")] };
    case "ARITHMETIC_MISMATCH":
      return { before: "Compare the figures with the document.", options: [fix("if they are printed that way, ask the vendor for a corrected invoice"), reject("if they were misread, reject it with a note")] };
    case "TAX_BASIS_UNCLEAR":
      return { options: [fix("ask the vendor to state whether prices include GST")] };
    case "TAX_RATE_MISMATCH":
      return { options: [fix("ask the vendor to correct the GST rate"), override("approve with an exception if the PO rate is the wrong one")] };
    case "MISSING_REQUIRED_FIELD":
      if (e.field === "bank account") return { before: String(e.action ?? ""), options: [override("approve with an exception only once the account matches"), reject("reject it if it does not")] };
      return { before: "Check the document.", options: [fix("if it is missing there too, ask the vendor for a complete invoice"), reject("if it was misread, reject it with a note")] };
    case "EVIDENCE_NOT_FOUND":
      return { before: "Compare these values with the document.", options: [override("approve with an exception only if each one is printed as read"), reject("otherwise reject it")] };
    case "SCAN_UNVERIFIED":
      return { before: "Compare the values with the image.", options: [override("approve with an exception if they match"), fix("or ask the vendor for a digital PDF")] };
    case "DATE_INVALID":
      return { options: [fix("ask the vendor to correct the date")] };
    case "APPROVAL_LIMIT_EXCEEDED":
      return { options: [override("approve with an exception only with the sign-off your approval policy requires, and name who gave it in the note")] };
    case "UNAPPROVED_CHARGE":
      return { options: [fix("ask the vendor to remove the charge"), override("approve with an exception if it was agreed")] };
    case "BUNDLED_QUANTITY_UNVERIFIED":
      return { before: "Confirm the work was completed.", options: [override("then approve with an exception"), fix("or ask the vendor for an itemised invoice")] };
    case "LINE_UNMAPPED":
    case "UOM_UNSUPPORTED":
    case "AI_PROPOSAL_REJECTED":
      return { before: "Check which PO item the line is.", options: [fix("ask the vendor to correct the line"), override("approve with an exception if it is on the PO as billed")] };
    case "PO_NOT_FOUND":
    case "PO_AMBIGUOUS":
      return { options: [fix("ask the vendor for the PO number"), override("approve with an exception and choose the PO it bills")] };
    case "PO_VENDOR_MISMATCH":
    case "PO_CLOSED":
      return { options: [fix("ask the vendor to check the PO number"), reject("reject it")] };
    case "VENDOR_UNKNOWN":
      return { before: "Add the vendor through onboarding before paying.", options: [reject("otherwise reject it")] };
    case "VENDOR_GSTIN_MISMATCH":
      return { before: `A different GSTIN can mean a different company. ${PHONE_CHECK(x)}`, options: [override("approve with an exception only after they confirm"), reject("reject it if they do not")] };
    case "SENDER_UNVERIFIED":
    case "BANK_DETAILS_CHANGED":
      return { before: PHONE_CHECK(x), options: [override("approve with an exception only after they confirm"), reject("reject it if they do not")] };
    case "POSSIBLE_DOUBLE_BILLING":
      if (e.earlier_state === "REJECTED") return { before: "Check why the earlier invoice was rejected.", options: [override("approve this one with an exception only if it is genuinely due"), reject("otherwise reject it")] };
      return { before: "Compare both invoices.", options: [["replace_approved", "replace the approved one only if this is the vendor's correction"], override("approve both with an exception only if both are due"), reject("otherwise reject this one")] };
    case "RELATED_INVOICE_DISPUTE":
      return { before: CODE_TEXT.RELATED_INVOICE_DISPUTE.next ?? "", options: [] };
    case "CORRECTION_UNCONFIRMED":
      return { options: [["confirm_link", "confirm the link if this replaces the held invoice"], reject("reject it if it does not")] };
    case "POSSIBLE_DUPLICATE":
      return { before: "Compare the two.", options: [reject("if it is the same invoice under a new number, reject it"), override("otherwise approve with an exception")] };
    case "CLASSIFICATION_CONFLICT":
      if (e.word != null) return { before: "Check the document.", options: [fix("if it is not a tax invoice, ask the vendor for one"), reject("or reject it")] };
      return { before: "Check the document.", options: [override("if it is an invoice, approve with an exception"), reject("if not, reject it")] };
    case "CREDIT_NOTE_UNSUPPORTED":
      return { before: CODE_TEXT.CREDIT_NOTE_UNSUPPORTED.next ?? "", options: [reject("reject it here")] };
    case "EXTRACTION_FAILED":
      return { options: [fix("ask the vendor for a clear PDF (their reply is read as a new invoice)"), reject("reject this one with a note")] };
    case "MANUAL_HOLD":
      return { before: "Resolve what the note describes.", options: [override("then approve with an exception"), fix("ask the vendor for a correction"), reject("or reject it")] };
    default:
      return { before: CODE_TEXT[issue.code]?.next ?? "", options: [] };
  }
}

function adviceText(a: Advice, offered: Set<ReviewAction>): string | null {
  const offeredOpts = a.options.filter(([act]) => act == null || offered.has(act)).map(([, t]) => t);
  const parts: string[] = [];
  if (a.before) parts.push(a.before);
  if (offeredOpts.length === 1) parts.push(`${cap(offeredOpts[0])}.`);
  else if (offeredOpts.length > 1) {
    const opts = offeredOpts.map((t) => t.replace(/^(or|otherwise) /, ""));
    parts.push(`${cap(opts.slice(0, -1).join("; "))}; or ${opts.at(-1)}.`);
  }
  return parts.length ? parts.join(" ") : null;
}

const severity = (c: ReasonCode) => {
  const i = SEVERITY.indexOf(c);
  return i < 0 ? SEVERITY.length : i;
};

/** The run's holds, most severe first, each with its figures and (while ON_HOLD) what to do. */
export function issuesOf(ctx: ExplainContext): IssueView[] {
  const { run } = ctx;
  const x = factsOf(ctx);
  const offered = new Set((ctx.actions ?? []).map((a) => a.action));
  const advise = run.state === "ON_HOLD";
  // U12: a MOCK run's line proposals came from the scripted MOCK proposer; nothing may call them AI.
  const unAi = (t: string) => (readerName(run) === "The AI" ? t : t.replace(/\bAI\b/g, "MOCK"));
  const findings = run.engine?.blocking ?? [];
  // An AI match rejected on a line explains the line's other codes (unmatched, unit unverified): one issue.
  const aiRejected = new Set(findings.filter((f) => f.code === "AI_PROPOSAL_REJECTED").map((f) => f.line_no));
  const out: IssueView[] = [];
  for (const f of findings) {
    if ((f.code === "LINE_UNMAPPED" || f.code === "UOM_UNSUPPORTED") && f.line_no != null && aiRejected.has(f.line_no)) continue;
    const paired = f.code === "AI_PROPOSAL_REJECTED" ? findings.filter((g) => g !== f && g.line_no === f.line_no && (g.code === "LINE_UNMAPPED" || g.code === "UOM_UNSUPPORTED")) : [];
    out.push({
      codes: [f.code, ...paired.map((g) => g.code)],
      title: unAi(CODE_TEXT[f.code]?.title ?? f.code),
      explain: unAi(explainFinding(f, x)),
      next: advise ? adviceText(adviceFor({ code: f.code, finding: f }, x), offered) : null,
      line_no: f.line_no ?? null,
      vendor_fixable: vendorFixable(f) || paired.some(vendorFixable),
    });
  }
  // Holds recorded on the run without an engine finding (spec 11 rows 2, 7 and 8).
  const covered = new Set(findings.map((f) => f.code));
  for (const code of run.blocking_codes) {
    if (covered.has(code) || REASON_CODES[code].kind !== "blocking") continue;
    let explain: string;
    if (code === "MANUAL_HOLD") explain = `Put on hold by a reviewer${ctx.holdNote ? `: "${ctx.holdNote}"` : ""}.`;
    else if (code === "EXTRACTION_FAILED") explain = `The document could not be read reliably: ${run.failure ?? `${readerName(run).replace(/^The /, "the ")}'s answer failed validation twice`}.`;
    else if (code === "RELATED_INVOICE_DISPUTE") {
      const by = (ctx.disputedBy ?? []).map((r) => r.ref);
      explain = `${by.length ? list(by) : "A later invoice"} has the same invoice number with different content, so this one is held until that is resolved.`;
    } else explain = CODE_TEXT[code]?.title ?? code;
    out.push({
      codes: [code], title: CODE_TEXT[code]?.title ?? code, explain,
      next: advise ? adviceText(adviceFor({ code }, x), offered) : null,
      line_no: null, vendor_fixable: code === "EXTRACTION_FAILED" || code === "MANUAL_HOLD",
    });
  }
  return out.sort((a, b) => severity(a.codes[0]) - severity(b.codes[0]) || (a.line_no ?? 0) - (b.line_no ?? 0));
}

/** The correction email's reasons: vendor-fixable findings only, in plain words, no rule codes (audit U03). */
export function vendorReasons(ctx: ExplainContext): string[] {
  const x = factsOf(ctx);
  const out: string[] = [];
  for (const f of ctx.run.engine?.blocking ?? []) {
    const s = vendorSentence(f, x);
    if (s && !out.includes(s)) out.push(s);
  }
  if (ctx.run.blocking_codes.includes("EXTRACTION_FAILED")) out.push("We could not read the invoice reliably. Please send it as a clear, digital PDF.");
  if (ctx.run.blocking_codes.includes("MANUAL_HOLD") && out.length === 0) out.push(ctx.holdNote ? ctx.holdNote : "We need to check some details on it before it can go on our payment list.");
  return out;
}

const PHONE_CODES: ReasonCode[] = ["VENDOR_UNKNOWN", "VENDOR_GSTIN_MISMATCH", "SENDER_UNVERIFIED", "BANK_DETAILS_CHANGED"];
const COMPARE_CODES: ReasonCode[] = ["POSSIBLE_DOUBLE_BILLING", "POSSIBLE_DUPLICATE", "RELATED_INVOICE_DISPUTE", "EXTRACTION_FAILED", "MANUAL_HOLD"];
/** Fixable by the vendor, but a reviewer's own check is the usual way out (CODE_TEXT advice), so no correction is pushed. */
const REVIEWER_FIRST: ReasonCode[] = ["BUNDLED_QUANTITY_UNVERIFIED", "SCAN_UNVERIFIED"];

/**
 * The action to lead with (audit U05), or null when the next step is a person's judgement (a phone call, a
 * comparison, a look at the document) rather than a button. Only an offered action is ever recommended.
 */
export function recommendedAction(run: RunRecord, actions: ActionOption[]): Recommended | null {
  const offered = new Set(actions.map((a) => a.action));
  const codes = run.blocking_codes;
  switch (run.state) {
    case "CLEARED":
      return offered.has("approve") ? { action: "approve", why: "Every check passed." } : null;
    case "FAILED":
      return offered.has("retry") ? { action: "retry", why: "Reading failed; retrying keeps this run and its history." } : null;
    case "ON_HOLD": {
      if (codes.length === 1 && codes[0] === "CORRECTION_UNCONFIRMED" && offered.has("confirm_link")) {
        return { action: "confirm_link", why: "If this is the vendor's corrected copy, confirming the link replaces the held invoice." };
      }
      if (codes.some((c) => PHONE_CODES.includes(c) || COMPARE_CODES.includes(c))) return null;
      const fixable = (run.engine?.blocking ?? []).filter(vendorFixable);
      if (offered.has("request_correction") && fixable.some((f) => !REVIEWER_FIRST.includes(f.code))) {
        return { action: "request_correction", why: "The vendor can fix this with a corrected invoice; their reply is linked by its reference and checked again." };
      }
      return null;
    }
    default:
      return null;
  }
}

/** The reviewer's note on the latest manual hold (row 7), quoted in the hold and its correction email. */
export function holdNoteOf(events: AuditEvent[]): string | null {
  return [...events].reverse().find((e) => e.type === "STATE_CHANGED" && e.to_state === "ON_HOLD" && e.code === "MANUAL_HOLD")?.note ?? null;
}
