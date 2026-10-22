import Decimal from "decimal.js";
import { addDays } from "../dates";
import { REASON_CODES, SEVERITY, type ReasonCode } from "../codes";
import { isLumpSum, matchedChargeKeywords } from "../detect";
import type { Extraction, ExtractionLine } from "../extraction-schema";
import { c1Compare, exceedsCap, paiseToRupees, roundToPaise, toPaise, type Paise, type PriceBasis } from "../money";
import { normInvoiceNumber, normPoRef, normText } from "../normalise";
import type { PoLine, PurchaseOrder, Vendor } from "../types";
import { assessArithmetic } from "./arithmetic";
import { m1Map, printedPackSize, proposalSupport, verifyUnits } from "./mapping";
import {
  STAGE_LABELS, type ConsumptionEntry, type CorrectionLink, type DisputeLink, type EngineInput, type EngineResult,
  type EvidenceValue, type Finding, type LineMatch, type Outcome, type PriorRun, type StageId, type StageResult,
} from "./types";

// Stages 2-9 of spec section 3, as one pure, deterministic function (apart from the injected M2 proposer).
// Rule order and normalisation follow spec section 16; codes and evidence follow sections 9-10.

const INVOICE_WORDS = ["invoice", "tax invoice", "bill of supply"];

/**
 * G1b (spec v1.4): wording that says a document "read as an invoice" is something else. Whole words only.
 * The title words come from the reading; the text words are checked against the document's own text layer, so a
 * misread title cannot hide them. A real tax invoice may mention the quotation it follows, hence the INVOICE_TEXT
 * exemption for quotation, estimate and challan (but never for proforma).
 */
const NOT_INVOICE_TITLE = /\b(quotation|quote|estimate|pro[\s-]?forma|challan|statement)\b/i;
const PROFORMA_TEXT = /\bpro[\s-]?forma\b/i;
const NOT_INVOICE_TEXT = /\b(quotation|estimate|delivery\s+challan)\b/i;
const INVOICE_TEXT = /\b(tax\s+invoice|bill\s+of\s+supply)\b/i;

/** K4b (spec v1.4): wording that shows a bank account is printed, so "no account read" is a misread, not an absence. */
export const BANK_WORDING = /(?<![a-z])(a\/c|acct|account\s*(no|number|#)|ifsc|bank\s*account)(?![a-z])/i;
const PAYABLE = new Set(["CLEARED", "APPROVED"]);
const HOLD_FAMILY = new Set(["ON_HOLD", "AWAITING_VENDOR"]);

const r = (p: Paise | null) => (p == null ? null : paiseToRupees(p));

class Trace {
  readonly stages: StageResult[] = [];
  private current: StageResult | null = null;

  start(stage: StageId) {
    this.current = { stage, label: STAGE_LABELS[stage], status: "passed", notes: [], findings: [] };
    this.stages.push(this.current);
  }
  note(text: string) {
    this.current!.notes.push(text);
  }
  add(code: ReasonCode, message: string, evidence: Record<string, EvidenceValue>, line_no?: number) {
    const f: Finding = { code, stage: this.current!.stage, message, evidence, ...(line_no != null ? { line_no } : {}) };
    this.current!.findings.push(f);
  }
  notEvaluated(stage: StageId, reason: string) {
    this.stages.push({ stage, label: STAGE_LABELS[stage], status: "not_evaluated", notes: [`not evaluated: ${reason}`], findings: [] });
  }
  finish() {
    for (const s of this.stages) {
      if (s.status === "not_evaluated") continue;
      const kinds = s.findings.map((f) => REASON_CODES[f.code].kind);
      s.status = kinds.includes("skip") ? "skipped" : kinds.includes("reject") ? "rejected" : kinds.includes("blocking") ? "held" : "passed";
    }
  }
  all(): Finding[] {
    return this.stages.flatMap((s) => s.findings);
  }
}


/** An amount's value as a canonical decimal string ("13000.00" and "13,000" -> "13000"); unparseable -> itself. */
function amountKey(v: string): string {
  const t = v.replace(/,/g, "").trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? new Decimal(t).toString() : t;
}

/** V3b: every number printed in the text (digits with Indian or Western grouping and decimals), by value. */
function printedAmounts(textLayer: string): Set<string> {
  const out = new Set<string>();
  for (const m of textLayer.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const t = m[0].replace(/,+$/, "");
    out.add(amountKey(t));
  }
  return out;
}

/** Pre-tax amount of a line in paise: exclusive / none as printed; inclusive divided by (1 + rate). */
function preTaxPaise(line: ExtractionLine, basis: PriceBasis): Paise {
  if (basis !== "inclusive") return toPaise(line.amount);
  return roundToPaise(new Decimal(line.amount).div(new Decimal(1).plus(line.gst_rate ?? 0)));
}

function findVendor(ex: Extraction, vendors: Vendor[]) {
  const g = ex.vendor_gstin?.trim().toUpperCase() || null;
  if (g) {
    const byGstin = vendors.find((v) => v.gstin?.toUpperCase() === g);
    if (byGstin) return { vendor: byGstin, method: "gstin" as const, gstinMismatch: false };
  }
  const name = normText(ex.vendor_name);
  if (name) {
    const byName = vendors.find((v) => [v.legal_name, ...v.aliases].some((n) => normText(n) === name));
    if (byName) return { vendor: byName, method: "name" as const, gstinMismatch: Boolean(g && byName.gstin && byName.gstin.toUpperCase() !== g) };
  }
  return { vendor: null, method: null, gstinMismatch: false };
}

function consumedBy(runs: PriorRun[], poNumber: string, exclude: string | null) {
  const qty = new Map<number, Decimal>();
  let amount = 0n;
  for (const run of runs) {
    if (!PAYABLE.has(run.state) || run.run_id === exclude) continue;
    for (const c of run.consumption) {
      if (c.po_number !== poNumber) continue;
      qty.set(c.line_no, (qty.get(c.line_no) ?? new Decimal(0)).plus(c.base_qty));
      amount += c.amount_paise;
    }
  }
  return { qty, amount };
}

function chargeLineAmountConsumed(runs: PriorRun[], poNumber: string, lineNo: number, exclude: string | null): Paise {
  let a = 0n;
  for (const run of runs) {
    if (!PAYABLE.has(run.state) || run.run_id === exclude) continue;
    for (const c of run.consumption) if (c.po_number === poNumber && c.line_no === lineNo) a += c.amount_paise;
  }
  return a;
}

export async function evaluate(input: EngineInput): Promise<EngineResult> {
  const { extraction: ex, document: doc, reference: ref, priorRuns, tokens } = input;
  const s = ref.settings;
  const tol = s.price_tolerance_pct;
  const qtyTol = s.quantity_tolerance_pct;
  const roundTol = roundToPaise(s.rounding_tolerance_inr);
  const t = new Trace();

  const result: EngineResult = {
    outcome: "ON_HOLD", blocking: [], info: [], primary_reason: null, stages: t.stages,
    vendor_id: null, chain_key: null, invoice_number_norm: ex.invoice_number ? normInvoiceNumber(ex.invoice_number) : null,
    invoice_date: ex.invoice_date, total_paise: ex.total != null ? toPaise(ex.total) : null,
    po_number: null, po_match_method: null, po_candidates: null, due_date: null, consumption: [], correction: null, dispute: null,
  };

  // ---- Stage 2: classification guard (G1-G3)
  t.start("classify");
  const titleAndLabel = `${ex.document_title ?? ""} ${ex.number_label ?? ""}`.toLowerCase();
  const invoiceWording = INVOICE_WORDS.some((w) => titleAndLabel.includes(w));
  t.note(`AI doc_type: ${ex.doc_type}; title "${ex.document_title ?? ""}"; number label "${ex.number_label ?? ""}"`);
  if (ex.doc_type === "credit_note") {
    t.add("CREDIT_NOTE_UNSUPPORTED", "Credit notes are not processed (G3)", { doc_type: ex.doc_type, title: ex.document_title });
  } else if (ex.doc_type === "invoice") {
    const inTitle = NOT_INVOICE_TITLE.exec(titleAndLabel);
    const proforma = PROFORMA_TEXT.exec(doc.text_layer);
    const otherDoc = NOT_INVOICE_TEXT.exec(doc.text_layer);
    const hit = inTitle ? { word: inTitle[0], where: "title or number label" }
      : proforma ? { word: proforma[0], where: "document text" }
      : otherDoc && !INVOICE_TEXT.test(doc.text_layer) ? { word: otherDoc[0], where: "document text" }
      : null;
    if (hit) {
      t.add("CLASSIFICATION_CONFLICT", `Read as an invoice, but the document's wording says "${hit.word}" (G1b)`, {
        doc_type: ex.doc_type, title: ex.document_title, number_label: ex.number_label, word: hit.word, found_in: hit.where,
      });
    }
  } else {
    if (invoiceWording) {
      // "PROFORMA INVOICE" says invoice too, but a proforma is not a tax invoice: keep the word, so the hold is the
      // vendor's to fix (send the tax invoice) and is not presented as our reader's mistake.
      const proforma = PROFORMA_TEXT.exec(titleAndLabel) ?? NOT_INVOICE_TITLE.exec(titleAndLabel);
      t.add("CLASSIFICATION_CONFLICT", "AI says this is not an invoice, but the title or number label says invoice (G2)", {
        doc_type: ex.doc_type, title: ex.document_title, number_label: ex.number_label,
        ...(proforma ? { word: proforma[0], found_in: "title or number label" } : {}),
      });
    } else if (doc.g1_bypassed) {
      t.note("G1 bypassed by a reviewer (process as invoice, row 5); every other check runs");
    } else {
      t.add("NOT_INVOICE", `Document is a ${ex.doc_type} with no invoice title or number label (G1)`, {
        doc_type: ex.doc_type, title: ex.document_title, number_label: ex.number_label,
      });
      for (const st of ["document", "vendor", "duplicates", "po", "lines", "compare"] as StageId[]) t.notEvaluated(st, "skipped at G1");
      return decide(t, result, input);
    }
  }

  // ---- Stage 3: document validation (V1-V5)
  t.start("document");
  const missing: string[] = [];
  if (!ex.invoice_number) missing.push("invoice number");
  if (!ex.invoice_date) missing.push("invoice date");
  if (!ex.vendor_name && !ex.vendor_gstin) missing.push("vendor identity");
  if (ex.lines.length === 0) missing.push("at least one line");
  if (ex.total == null) missing.push("total");
  if (missing.length) t.add("MISSING_REQUIRED_FIELD", `Required field missing: ${missing.join(", ")} (V1)`, { missing });

  if (ex.total != null && ex.lines.length > 0) {
    const a = assessArithmetic(ex, roundTol);
    if (a.status === "consistent") {
      const basis = a.used_basis === "none" ? "with no GST" : `on the ${a.used_basis} basis`;
      t.note(`V2: arithmetic consistent ${basis} (within Rs ${s.rounding_tolerance_inr})`);
    }
    else if (a.status === "basis_unclear") {
      t.add("TAX_BASIS_UNCLEAR", `Price basis unclear: ${a.reason} (T3)`, {
        stated_basis: a.stated_basis, consistent_bases: a.consistent_bases,
        failed_check: a.failed?.check ?? null, expected: a.failed?.expected ?? null, actual: a.failed?.actual ?? null,
      });
    } else {
      t.add("ARITHMETIC_MISMATCH", `Arithmetic does not add up: ${a.failed?.check ?? a.reason} (V2)`, {
        basis: a.used_basis, check: a.failed?.check ?? null, computed: a.failed?.expected ?? null, printed: a.failed?.actual ?? null,
      });
    }
  } else t.note("V2 not evaluated: total or lines missing");

  if (doc.has_text_layer) {
    const text = normText(doc.text_layer);
    const amounts = printedAmounts(doc.text_layer);
    // V3b (spec v1.4, audit A05): an amount must be printed as a whole number on the page, equal in value
    // ("13,000.00" for 13000), not found inside a longer one ("1,00,000" no longer vouches for 1000).
    const needles: [string, string, "text" | "amount"][] = [];
    if (ex.invoice_number) needles.push(["invoice number", ex.invoice_number, "text"]);
    if (ex.total != null) needles.push(["total", ex.total, "amount"]);
    if (ex.po_reference) needles.push(["PO reference", ex.po_reference, "text"]);
    for (const l of ex.lines) {
      needles.push([`line ${l.line_no} amount`, l.amount, "amount"]);
      if (l.unit_price != null) needles.push([`line ${l.line_no} unit price`, l.unit_price, "amount"]);
    }
    if (ex.bank_account_last4) needles.push(["bank account last 4", ex.bank_account_last4, "text"]);
    const found = ([, v, kind]: (typeof needles)[number]) => (kind === "amount" ? amounts.has(amountKey(v)) : text.includes(normText(v)));
    const notFound = needles.filter((n) => !found(n)).map(([k, v]) => `${k} = ${v}`);
    if (notFound.length) {
      t.add("EVIDENCE_NOT_FOUND", "Extracted values not found in the document's text layer (V3)", { searched: needles.length, not_found: notFound });
    } else t.note(`V3: all ${needles.length} extracted values found in the text layer`);
  } else {
    t.add("SCAN_UNVERIFIED", "No usable text layer: values come from the image only and need human confirmation (V4)", {
      text_layer_characters: doc.text_layer.replace(/\s/g, "").length, required: 50,
    });
  }
  if (ex.invoice_date && ex.invoice_date > addDays(input.today, 1)) {
    t.add("DATE_INVALID", "Invoice date is more than 1 day in the future (V5)", { invoice_date: ex.invoice_date, today: input.today });
  }

  // ---- Stage 4: vendor, sender, bank (K1-K4)
  t.start("vendor");
  const found = findVendor(ex, ref.vendors);
  const vendor = found.vendor;
  const sender = doc.sender_email?.trim().toLowerCase() ?? null;
  const allowlisted = sender != null && s.ap_forwarder_allowlist.some((a) => a.toLowerCase() === sender);
  const spoofSuspected = doc.source === "email" && doc.sender_authenticated === false;
  const registered = !spoofSuspected && sender != null && vendor != null && vendor.registered_senders.some((a) => a.toLowerCase() === sender);
  if (!vendor) {
    t.add("VENDOR_UNKNOWN", "Vendor not in the trusted vendor master (K1)", { vendor_name: ex.vendor_name, vendor_gstin: ex.vendor_gstin });
  } else {
    result.vendor_id = vendor.vendor_id;
    t.note(`K1: vendor ${vendor.vendor_id} ${vendor.legal_name} matched by ${found.method}`);
    if (found.gstinMismatch) {
      t.add("VENDOR_GSTIN_MISMATCH", "Vendor name matches the master but the GSTIN differs (K2)", { printed: ex.vendor_gstin, master: vendor.gstin });
    }
  }
  if (doc.source === "email") {
    if (spoofSuspected) {
      t.add("SENDER_UNVERIFIED", "The email failed sender authentication (DMARC), so the From address cannot be trusted (K3)", {
        sender, authentication: "failed",
      });
    } else if (registered) t.note(`K3: sender ${sender} is registered for ${vendor!.vendor_id}`);
    else if (allowlisted) t.note(`K3: sender ${sender} is on the AP-forwarder allowlist`);
    else {
      t.add("SENDER_UNVERIFIED", "Sender is not registered for this vendor and not on the AP-forwarder allowlist (K3)", {
        sender, registered_senders: vendor?.registered_senders ?? [],
      });
    }
  } else {
    t.note(`K3 not evaluated: internal upload by ${doc.uploader_display_name ?? "unknown"} (demo identity)`);
  }
  if (!vendor) {
    t.note("K4 not evaluated: vendor unknown");
    for (const st of ["duplicates", "po", "lines", "compare"] as StageId[]) t.notEvaluated(st, "vendor unknown");
    return decide(t, result, input);
  }
  // K4b: no account digits were read (an unreadable value such as "XXXX XXXX" counts as not read), yet the page
  // shows bank wording, or the reader returned something for the account: a misread, not an absence.
  const readAs = ex.bank_account_number?.trim() ? `read as "${ex.bank_account_number.trim()}"` : null;
  const printedBank = !ex.bank_account_last4 ? (BANK_WORDING.exec(doc.text_layer)?.[0] ?? readAs) : null;
  if (printedBank) {
    t.add("MISSING_REQUIRED_FIELD", "A bank account is printed on the document but was not read; it cannot be checked against the vendor master (K4b)", {
      field: "bank account", printed_wording: printedBank, master_last4: vendor.bank_last4,
      action: `Read the account on the document and compare it with the master (ending ${vendor.bank_last4}); if it differs, verify by phone using ${vendor.phone}`,
    });
  } else if (!ex.bank_account_last4) {
    t.add("BANK_NOT_SHOWN", "No bank account printed; nothing to compare (K4)", { master_last4: vendor.bank_last4 });
  } else if (ex.bank_account_last4 !== vendor.bank_last4) {
    t.add("BANK_DETAILS_CHANGED", "Bank account differs from the trusted vendor master (K4)", {
      printed_last4: ex.bank_account_last4, master_last4: vendor.bank_last4,
      action: `Verify by phone using the vendor master number ${vendor.phone}, not any number on the invoice`,
    });
  } else t.note(`K4: bank account ending ${vendor.bank_last4} matches the vendor master`);

  // ---- Stage 5: duplicates and corrections (D1-D4)
  t.start("duplicates");
  let correction: CorrectionLink | null = null;
  let dispute: DisputeLink | null = null;
  let excludeFromConsumption: string | null = null;
  if (!result.invoice_number_norm) {
    t.note("D1-D4 not evaluated: no invoice number");
  } else {
    const chainKey = `${vendor.vendor_id}|${result.invoice_number_norm}`;
    result.chain_key = chainKey;
    const chain = priorRuns.filter((p) => p.chain_key === chainKey && p.state !== "FAILED" && p.state !== "SKIPPED");
    const dup = chain.find((p) => p.invoice_date === ex.invoice_date && p.total_paise != null && p.total_paise === result.total_paise);
    if (dup) {
      t.add("DUPLICATE_INVOICE", "Same vendor, invoice number, date and total as an earlier run (D1)", {
        earlier_run: dup.run_id, earlier_state: dup.state, normalised_number: result.invoice_number_norm,
        invoice_date: ex.invoice_date, total: ex.total,
      });
      for (const st of ["po", "lines", "compare"] as StageId[]) t.notEvaluated(st, "rejected as a duplicate");
      return decide(t, result, input);
    }
    const payable = chain.find((p) => PAYABLE.has(p.state));
    const holdFamily = chain.filter((p) => HOLD_FAMILY.has(p.state));
    const rejected = chain.find((p) => p.state === "REJECTED");
    if (payable) {
      dispute = { counterpart_run_id: payable.run_id, counterpart_state: payable.state, counterpart_exported: payable.exported };
      if (payable.state === "CLEARED" || !payable.exported) excludeFromConsumption = payable.run_id;
      t.add("POSSIBLE_DOUBLE_BILLING", "Same invoice number as a payable run, different content (D3)", {
        earlier_run: payable.run_id, earlier_state: payable.state, earlier_exported: payable.exported,
        earlier_date: payable.invoice_date, earlier_total: r(payable.total_paise), this_date: ex.invoice_date, this_total: ex.total,
      });
    } else if (holdFamily.length > 0) {
      const target = doc.reply_token ? tokens.get(doc.reply_token) ?? null : null;
      // A12: a token is valid only while its run is ON_HOLD or AWAITING_VENDOR.
      const tokenRun = target ? chain.find((p) => p.run_id === target) : undefined;
      const targetRun = tokenRun && HOLD_FAMILY.has(tokenRun.state) ? tokenRun : undefined;
      const linked = Boolean(targetRun) && doc.source === "email" && registered;
      correction = {
        kind: linked ? "linked" : "unlinked", hold_family_run_ids: holdFamily.map((p) => p.run_id),
        token: doc.reply_token, token_target_run_id: target,
      };
      if (linked) {
        t.note(`D2: reply token ${doc.reply_token} links this run to ${target} in the same chain, from the registered sender`);
      } else {
        const why = !doc.reply_token ? "no reply token" : !target ? "token not issued by us" : !tokenRun ? "token belongs to another chain"
          : !targetRun ? `token no longer valid: its invoice is ${tokenRun.state}` : spoofSuspected ? "sender failed authentication" : "sender not registered for this vendor";
        t.add("CORRECTION_UNCONFIRMED", `Looks like a correction of a held invoice, but it is not linked: ${why} (D2)`, {
          earlier_runs: holdFamily.map((p) => p.run_id), token: doc.reply_token, revision_marker: ex.revision_marker, reason: why,
        });
      }
    } else if (rejected) {
      t.add("POSSIBLE_DOUBLE_BILLING", "Same invoice number as a rejected run, different content (D3, hold only)", {
        earlier_run: rejected.run_id, earlier_state: rejected.state,
      });
    }
    const sameVendorDateTotal = priorRuns.find((p) => p.vendor_id === vendor.vendor_id && p.chain_key !== chainKey
      && p.state !== "FAILED" && p.state !== "SKIPPED" && p.invoice_date === ex.invoice_date
      && p.total_paise != null && p.total_paise === result.total_paise);
    if (sameVendorDateTotal) {
      t.add("POSSIBLE_DUPLICATE", "Different invoice number, but same vendor, date and total as an earlier run (D4)", {
        earlier_run: sameVendorDateTotal.run_id, invoice_date: ex.invoice_date, total: ex.total,
      });
    }
  }
  result.correction = correction;
  result.dispute = dispute;

  // ---- Stage 6: PO match (P1-P2)
  t.start("po");
  let po: PurchaseOrder | null = null;
  const vendorOpenPos = ref.purchaseOrders.filter((p) => p.vendor_id === vendor.vendor_id && p.status === "open");
  if (ex.po_reference) {
    const n = normPoRef(ex.po_reference);
    const match = ref.purchaseOrders.find((p) => normPoRef(p.po_number) === n);
    if (!match) t.add("PO_NOT_FOUND", "PO reference not found (P1)", { reference: ex.po_reference, normalised: n });
    else if (match.vendor_id !== vendor.vendor_id) t.add("PO_VENDOR_MISMATCH", "PO belongs to another vendor (P1)", { po: match.po_number, owner: match.vendor_id, vendor: vendor.vendor_id });
    else if (match.status !== "open") t.add("PO_CLOSED", "PO is not open (P1)", { po: match.po_number, status: match.status });
    else {
      po = match;
      result.po_match_method = "reference";
      t.note(`P1: "${ex.po_reference}" matched ${po.po_number}`);
    }
  } else {
    result.po_candidates = vendorOpenPos.map((p) => p.po_number).sort();
    let candidates = vendorOpenPos;
    if (candidates.length > 1) candidates = candidates.filter((p) => ex.lines.every((l) => m1Map(l, p) != null));
    if (candidates.length === 1) {
      po = candidates[0];
      result.po_match_method = "inferred";
      t.add("PO_INFERRED", `No PO printed; inferred ${po.po_number}, the only open PO on which every line maps (P2)`, {
        open_pos: result.po_candidates, inferred: po.po_number,
      });
    } else if (candidates.length > 1) {
      t.add("PO_AMBIGUOUS", "No PO printed and more than one open PO fits; never guess (P2)", { open_pos: result.po_candidates, fitting: candidates.map((p) => p.po_number) });
    } else {
      t.add("PO_NOT_FOUND", "No PO printed and no open PO of this vendor fits (P2)", { open_pos: result.po_candidates });
    }
  }
  result.po_number = po?.po_number ?? null;
  if (!po) {
    t.notEvaluated("lines", "no PO");
    t.notEvaluated("compare", "no PO");
    return decide(t, result, input);
  }

  // ---- Stage 7: lines, charges, tax basis (M7 -> M5 -> M1 -> M2/M3 -> M4 -> T4; spec 16.2)
  t.start("lines");
  const basis: PriceBasis = ex.price_basis ?? "none";
  const consumed = consumedBy(priorRuns, po.po_number, excludeFromConsumption);
  if (excludeFromConsumption) t.note(`C2/C3 exclude ${excludeFromConsumption}'s consumption: this run is assessed as its possible replacement (A8)`);
  const used = new Map<number, number>(); // PO line -> invoice line
  const mapped: { line: ExtractionLine; poLine: PoLine; factor: number; via: string; preTax: Paise; baseQty: Decimal }[] = [];
  const consumption: ConsumptionEntry[] = [];
  // C4b (spec v1.4): a held line still has a PO. Its pre-tax amount is recorded at PO level (line 0, no quantity),
  // like a lump-sum line. Consumption only counts once the run is CLEARED or APPROVED, so this matters only when a
  // person approves the invoice by override: the PO is then used up and a later invoice cannot clear against it too.
  const matches: LineMatch[] = [];
  const poLineOf = (n: number | null | undefined) => (n == null ? undefined : po.lines.find((pl) => pl.line_no === n));
  // A held line still counts if a reviewer approves the invoice. When the code knows which PO line it bills (an
  // over-cap charge, a second line on an already-billed PO line), it counts there, so the per-line caps (M7 charge
  // amount, C2 quantity) see it; otherwise at PO level (line 0, amount only, for C3).
  const heldAtPoLevel = (line: ExtractionLine, code: ReasonCode, poLineNo?: number, countOn?: { line: number; baseQty: string }) => {
    consumption.push({ po_number: po.po_number, line_no: countOn?.line ?? 0, base_qty: countOn?.baseQty ?? "0", amount_paise: preTaxPaise(line, basis) });
    matches.push(lineMatch(line, poLineOf(poLineNo), "held", code));
  };

  for (const line of ex.lines) {
    const keywords = matchedChargeKeywords(line.description, s);
    if (keywords.length > 0) {
      const poCharge = po.lines.find((pl) => pl.line_kind === "charge" && matchedChargeKeywords(pl.description, s).some((k) => keywords.includes(k)));
      const amount = preTaxPaise(line, basis);
      if (!poCharge) {
        t.add("UNAPPROVED_CHARGE", `Charge line "${line.description}" has no matching charge line on ${po.po_number} (M7)`, {
          keywords, amount: r(amount), po_charge_lines: po.lines.filter((pl) => pl.line_kind === "charge").map((pl) => pl.description),
        }, line.line_no);
        heldAtPoLevel(line, "UNAPPROVED_CHARGE");
      } else {
        const already = chargeLineAmountConsumed(priorRuns, po.po_number, poCharge.line_no, excludeFromConsumption);
        if (exceedsCap(amount + already, poCharge.line_amount_pretax, tol)) {
          t.add("UNAPPROVED_CHARGE", `Charge exceeds the PO charge line by more than ${tol}% (M7)`, {
            keywords, amount: r(amount), already_billed: r(already), po_amount: r(poCharge.line_amount_pretax),
          }, line.line_no);
          heldAtPoLevel(line, "UNAPPROVED_CHARGE", poCharge.line_no, { line: poCharge.line_no, baseQty: "1" });
        } else {
          t.note(`M7: line ${line.line_no} "${line.description}" accepted against PO charge line ${poCharge.line_no}`);
          consumption.push({ po_number: po.po_number, line_no: poCharge.line_no, base_qty: "1", amount_paise: amount });
          matches.push(lineMatch(line, poCharge, "charge"));
        }
      }
      continue;
    }
    if (isLumpSum(line.description, line.uom, s)) {
      const remaining = po.subtotal_pretax - consumed.amount;
      const amount = preTaxPaise(line, basis);
      const code: ReasonCode = amount <= remaining ? "BUNDLED_QUANTITY_UNVERIFIED" : "PO_AMOUNT_EXCEEDED";
      t.add(code, code === "BUNDLED_QUANTITY_UNVERIFIED"
        ? `Lump-sum line: quantities per PO line cannot be verified (M5)`
        : `Lump-sum line exceeds what remains on ${po.po_number} (M5)`, {
        description: line.description, amount: r(amount), po_remaining: r(remaining), po_subtotal: r(po.subtotal_pretax),
      }, line.line_no);
      // A lump-sum line is always held, but if a reviewer approves the invoice it uses up that much of the PO
      // amount (line 0 = PO level, no quantity), so a later invoice for the same work cannot clear against it too.
      consumption.push({ po_number: po.po_number, line_no: 0, base_qty: "0", amount_paise: amount });
      matches.push(lineMatch(line, undefined, "lump_sum", code));
      continue;
    }
    let poLine = m1Map(line, po);
    let factor = 1;
    let via = "";
    if (poLine) {
      const u = verifyUnits(line.uom, poLine, ref.catalog);
      const printed = printedPackSize(line.description);
      if (!u.ok || (u.via === "catalog pack" && printed != null && printed !== u.factor)) {
        t.add("UOM_UNSUPPORTED", `Line ${line.line_no} maps to PO line ${poLine.line_no} but the unit cannot be verified (M3)`, {
          invoice_unit: line.uom, po_unit: poLine.uom, reason: u.ok ? `printed pack size ${printed} differs from catalog ${u.factor}` : u.reason,
        }, line.line_no);
        heldAtPoLevel(line, "UOM_UNSUPPORTED", poLine.line_no);
        continue;
      }
      factor = u.factor;
      via = `M1 (${u.reason})`;
    } else if (input.proposer) {
      const proposal = await input.proposer.propose({ po, line, candidates: po.lines.filter((pl) => pl.line_kind !== "charge") });
      const target = proposal?.proposed_po_line != null ? po.lines.find((pl) => pl.line_no === proposal.proposed_po_line && pl.line_kind !== "charge") : undefined;
      if (!proposal || !target) {
        t.add("LINE_UNMAPPED", `Line ${line.line_no} "${line.description}" matches no PO line (M1), and the AI proposed none (M2)`, {
          description: line.description, po: po.po_number, proposer: proposal?.by ?? input.proposer.label, proposal: proposal?.justification ?? null,
        }, line.line_no);
        heldAtPoLevel(line, "LINE_UNMAPPED");
        continue;
      }
      const u = verifyUnits(line.uom, target, ref.catalog);
      const printed = printedPackSize(line.description);
      const packOk = u.via !== "catalog pack" || (printed === u.factor && proposal.pack_size_read === u.factor);
      if (!u.ok || !packOk) {
        t.add("AI_PROPOSAL_REJECTED", `AI proposed PO line ${target.line_no}, but code could not verify it (M3)`, {
          proposal: proposal.justification, proposed_po_line: target.line_no, pack_size_read: proposal.pack_size_read,
          printed_pack_size: printed, reason: u.ok ? `pack size: printed ${printed}, proposal read ${proposal.pack_size_read}, catalog ${u.factor}` : u.reason,
        }, line.line_no);
        t.add("UOM_UNSUPPORTED", `Line ${line.line_no}: unit conversion not verified (M3)`, { invoice_unit: line.uom, po_unit: target.uom }, line.line_no);
        heldAtPoLevel(line, "AI_PROPOSAL_REJECTED", target.line_no);
        continue;
      }
      const support = proposalSupport(line, target, ref.catalog, u.via === "catalog pack" && printed === u.factor && proposal.pack_size_read === u.factor);
      if (!support.ok) {
        t.add("AI_PROPOSAL_REJECTED", `AI proposed PO line ${target.line_no}, but nothing on the invoice line supports it (M3, v1.4)`, {
          proposal: proposal.justification, proposed_po_line: target.line_no, invoice_line: line.description, po_line: target.description, reason: support.reason,
        }, line.line_no);
        t.add("LINE_UNMAPPED", `Line ${line.line_no} "${line.description}" is not matched to ${po.po_number}: the AI proposal was rejected (M3)`, {
          description: line.description, po: po.po_number,
        }, line.line_no);
        heldAtPoLevel(line, "AI_PROPOSAL_REJECTED", target.line_no);
        continue;
      }
      poLine = target;
      factor = u.factor;
      via = `M2 proposal verified by code (${u.reason})`;
      t.add("LINE_MAPPED_AI_VERIFIED", `Line ${line.line_no} mapped to PO line ${target.line_no} by an AI proposal that code verified (M2-M3)`, {
        proposal: proposal.justification, proposer: proposal.by ?? input.proposer.label, verification: `${u.reason}; ${support.reason}`,
      }, line.line_no);
    } else {
      t.add("LINE_UNMAPPED", `Line ${line.line_no} "${line.description}" matches no PO line (M1); no AI mapping available`, {
        description: line.description, po: po.po_number, possible_charge: line.qty == null && line.uom == null,
      }, line.line_no);
      heldAtPoLevel(line, "LINE_UNMAPPED");
      continue;
    }
    const earlier = used.get(poLine.line_no);
    if (earlier != null) {
      t.add("LINE_UNMAPPED", `Line ${line.line_no} maps to PO line ${poLine.line_no}, already matched by invoice line ${earlier} (M4)`, {
        po_line: poLine.line_no, earlier_invoice_line: earlier,
      }, line.line_no);
      heldAtPoLevel(line, "LINE_UNMAPPED", poLine.line_no, { line: poLine.line_no, baseQty: new Decimal(line.qty ?? 0).mul(factor).toString() });
      continue;
    }
    used.set(poLine.line_no, line.line_no);
    if (line.gst_rate != null && !new Decimal(line.gst_rate).eq(poLine.gst_rate)) {
      t.add("TAX_RATE_MISMATCH", `Line ${line.line_no} GST rate differs from the PO (T4)`, { invoice_rate: line.gst_rate, po_rate: poLine.gst_rate }, line.line_no);
    }
    const baseQty = new Decimal(line.qty ?? 0).mul(factor);
    mapped.push({ line, poLine, factor, via, preTax: preTaxPaise(line, basis), baseQty });
    t.note(`Line ${line.line_no} -> PO line ${poLine.line_no} "${poLine.description}" via ${via}`);
  }

  // ---- Stage 8: compare to PO (C1-C5), mapped goods and service lines only
  t.start("compare");
  let mappedAmount = 0n;
  for (const m of mapped) {
    const { line, poLine } = m;
    if (line.unit_price == null || line.qty == null) {
      t.add("LINE_UNMAPPED", `Line ${line.line_no} has no quantity or unit price to compare`, { po_line: poLine.line_no }, line.line_no);
      matches.push(lineMatch(line, poLine, "held", "LINE_UNMAPPED"));
      consumption.push({ po_number: po.po_number, line_no: poLine.line_no, base_qty: m.baseQty.toString(), amount_paise: m.preTax }); // counts if approved
      continue;
    }
    const verdict = c1Compare(line.unit_price, poLine.unit_price_pretax, basis, line.gst_rate ?? 0, m.factor, tol);
    const prePrice = basis === "inclusive" ? new Decimal(line.unit_price).div(new Decimal(1).plus(line.gst_rate ?? 0)) : new Decimal(line.unit_price);
    const basePrice = prePrice.div(m.factor);
    const pct = basePrice.minus(poLine.unit_price_pretax).div(poLine.unit_price_pretax).mul(100).toDecimalPlaces(2).toString();
    const ev = { invoice_price_per_base_unit: basePrice.toDecimalPlaces(4).toString(), po_price: poLine.unit_price_pretax, difference_pct: pct, tolerance_pct: tol, basis };
    if (verdict === "over") t.add("PRICE_OVER_TOLERANCE", `Line ${line.line_no} price is ${pct}% above the PO (C1)`, ev, line.line_no);
    else if (verdict === "below") t.add("PRICE_BELOW_PO", `Line ${line.line_no} price is ${pct}% below the PO (C1)`, ev, line.line_no);
    else t.add("PRICE_WITHIN_TOLERANCE", `Line ${line.line_no} price within ${tol}% of the PO (C1: ${pct}%)`, ev, line.line_no);

    const already = consumed.qty.get(poLine.line_no) ?? new Decimal(0);
    const cap = new Decimal(poLine.qty_ordered).mul(new Decimal(100).plus(qtyTol)).div(100);
    if (m.baseQty.plus(already).gt(cap)) {
      t.add("QTY_EXCEEDS_PO", `Line ${line.line_no}: ${m.baseQty} invoiced + ${already} already billed exceeds ${poLine.qty_ordered} ordered (C2)`, {
        invoiced: m.baseQty.toString(), already_billed: already.toString(), ordered: poLine.qty_ordered, po_line: poLine.line_no,
      }, line.line_no);
    }
    mappedAmount += m.preTax;
    consumption.push({ po_number: po.po_number, line_no: poLine.line_no, base_qty: m.baseQty.toString(), amount_paise: m.preTax });
    matches.push({
      ...lineMatch(line, poLine, "matched"),
      via: m.via, base_qty: m.baseQty.toString(), price_per_po_unit: basePrice.toDecimalPlaces(4).toString(), price_diff_pct: pct, price_result: verdict,
      already_billed: already.toString(), qty_result: m.baseQty.plus(already).gt(cap) ? "over" : "within",
    });
  }
  result.line_matches = [...matches].sort((a, b) => a.invoice_line - b.invoice_line);
  if (mapped.length > 0 && exceedsCap(mappedAmount + consumed.amount, po.subtotal_pretax, tol)) {
    t.add("PO_AMOUNT_EXCEEDED", `Invoiced plus already billed exceeds ${po.po_number} by more than ${tol}% (C3)`, {
      invoiced_pretax: r(mappedAmount), already_billed: r(consumed.amount), po_subtotal: r(po.subtotal_pretax),
      cap: paiseToRupees(roundToPaise(new Decimal(po.subtotal_pretax.toString()).div(100).mul(new Decimal(100).plus(tol)).div(100))),
    });
  } else if (mapped.length > 0) {
    t.note(`C3: ${r(mappedAmount)} invoiced + ${r(consumed.amount)} already billed within ${po.po_number} cap`);
  }
  const limit = roundToPaise(s.approval_limit_inr);
  if (result.total_paise != null && result.total_paise > limit) {
    t.add("APPROVAL_LIMIT_EXCEEDED", "Total above the approval limit (C5)", { total: ex.total, limit: paiseToRupees(limit) });
  }
  result.consumption = consumption;
  return decide(t, result, input);
}

/** One invoice line set against the PO, for the reviewer's comparison table. Presentation only: it decides nothing. */
function lineMatch(line: ExtractionLine, pl: PoLine | undefined, status: LineMatch["status"], code?: ReasonCode): LineMatch {
  return {
    invoice_line: line.line_no, description: line.description, qty: line.qty, uom: line.uom, unit_price: line.unit_price, amount: line.amount,
    status, ...(code ? { hold_code: code } : {}),
    po_line: pl?.line_no ?? null, po_description: pl?.description ?? null, po_uom: pl?.uom ?? null, po_unit_price: pl?.unit_price_pretax ?? null,
    ordered: pl?.qty_ordered ?? null, via: null, base_qty: null, price_per_po_unit: null, price_diff_pct: null, price_result: null, already_billed: null, qty_result: null,
  };
}

/**
 * C4b (spec v1.4): what an invoice uses of a PO a reviewer names at override (no PO was found by the code). Lines
 * that map by M1 with a verified unit count per PO line (quantity and amount); every other line counts at PO level
 * (line 0, amount only). Deterministic only: no AI proposal is used.
 */
export function consumptionAgainst(ex: Extraction, po: PurchaseOrder, catalog: EngineInput["reference"]["catalog"]): ConsumptionEntry[] {
  const basis: PriceBasis = ex.price_basis ?? "none";
  const used = new Set<number>();
  return ex.lines.map((line) => {
    const pl = m1Map(line, po);
    const u = pl ? verifyUnits(line.uom, pl, catalog) : null;
    const printed = printedPackSize(line.description);
    const unitOk = pl && u?.ok && !(u.via === "catalog pack" && printed != null && printed !== u.factor) && !used.has(pl.line_no);
    if (pl && u && unitOk) {
      used.add(pl.line_no);
      return { po_number: po.po_number, line_no: pl.line_no, base_qty: new Decimal(line.qty ?? 0).mul(u.factor).toString(), amount_paise: preTaxPaise(line, basis) };
    }
    return { po_number: po.po_number, line_no: 0, base_qty: "0", amount_paise: preTaxPaise(line, basis) };
  });
}

function decide(t: Trace, result: EngineResult, input: EngineInput): EngineResult {
  t.start("decide");
  const correction = result.correction;
  let findings = t.all();
  const has = (kind: string) => findings.some((f) => REASON_CODES[f.code].kind === kind);
  let outcome: Outcome;
  if (has("skip")) outcome = "SKIPPED";
  else if (has("reject")) outcome = "REJECTED";
  else if (has("blocking")) outcome = "ON_HOLD";
  else {
    const p9 = result.chain_key && input.priorRuns.find((p) => p.chain_key === result.chain_key && PAYABLE.has(p.state));
    if (p9) {
      t.add("POSSIBLE_DOUBLE_BILLING", "Clearing would put two payable runs in one chain (P9)", { earlier_run: p9.run_id });
      outcome = "ON_HOLD";
    } else outcome = "CLEARED";
  }
  if (correction?.kind === "linked") {
    if (outcome === "CLEARED") {
      t.add("CORRECTION_OF", "Token-linked correction passed every check; the held original(s) are superseded (D2, row 15)", {
        supersedes: correction.hold_family_run_ids, token: correction.token,
      });
    } else {
      t.add("CORRECTION_CANDIDATE_OF", "Token-linked correction, but a check failed: nothing is superseded (D2)", {
        original_runs: correction.hold_family_run_ids, token: correction.token,
      });
    }
  }
  if (outcome === "CLEARED" && result.invoice_date && result.vendor_id) {
    const v = input.reference.vendors.find((x) => x.vendor_id === result.vendor_id)!;
    result.due_date = addDays(result.invoice_date, v.payment_terms_days);
    t.note(`Due (per terms): ${result.due_date} (${v.payment_terms_days} days)`);
  }
  t.note(`Outcome: ${outcome}`);
  t.finish();
  findings = t.all();
  result.outcome = outcome;
  result.blocking = findings.filter((f) => ["blocking", "skip", "reject"].includes(REASON_CODES[f.code].kind));
  result.info = findings.filter((f) => REASON_CODES[f.code].kind === "info");
  const blockingCodes = new Set(result.blocking.map((f) => f.code));
  result.primary_reason = SEVERITY.find((c) => blockingCodes.has(c)) ?? result.blocking[0]?.code ?? null;
  // decide-stage status reflects the outcome, not only its own findings
  const d = t.stages[t.stages.length - 1];
  d.status = outcome === "CLEARED" ? "passed" : outcome === "ON_HOLD" ? "held" : outcome === "REJECTED" ? "rejected" : "skipped";
  return result;
}

