"""
Independent validator for Zamp PS-1 test data v2 (spec v1.2.2, test matrix v1.2.2).

Does NOT import the generator. Reads only the generated files and checks them against:
  1. Figures transcribed from claude/test-matrix.md v1.2.2 (reference data and key totals).
  2. The PDFs themselves (text layer, required evidence strings, page count, size).
  3. Arithmetic recomputed from line items.
  4. A rule oracle: an independent, minimal implementation of the checks in
     claude/workflow-spec.md v1.2.2, run over the scenario sequence and the isolated
     X tests, compared with the declared expected outcomes in answer_key.json.
  5. Mutation checks that prove the oracle can distinguish outcomes.

The oracle consumes the ground-truth extraction (what a perfect reader would return).
It therefore validates the DATA and the EXPECTED OUTCOMES, not the application or the AI.

Run:  python scripts/validate_test_data.py      (exit code 0 = all checks passed)
Needs: pdfplumber, pypdf; optional: tesseract + pdftoppm (OCR legibility of the scan)
"""

from __future__ import annotations

import copy
import csv
import json
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import date, timedelta
from decimal import Decimal as D
from pathlib import Path

import pdfplumber
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent.parent
TD = ROOT / "test-data"
REF_DATE = date(2026, 10, 22)  # V5 reference "today"

results: list[tuple[str, str, bool, str]] = []  # (section, check, ok, detail)


def check(section, name, ok, detail=""):
    """ok: True = PASS, False = FAIL, None = SKIP (not executed; never counted as a pass)."""
    results.append((section, name, None if ok is None else bool(ok), detail))
    return ok


# ---------------------------------------------------------------------------
# Figures transcribed from test-matrix.md v1.2.2 (independent of the generator)
# ---------------------------------------------------------------------------
MATRIX_VENDORS = {
    "V01": ("FreshPack Packaging", "29AAFCF1234K1Z5", "4417", 30),
    "V02": ("CleanCo Hygiene Supplies", "29AAGCC5678M1Z2", "2290", 30),
    "V03": ("Kumar Vegetables", "", "7781", 7),
    "V04": ("BlueFlame Gas Supplies", "29AABCB4321P1Z8", "5530", 15),
    "V05": ("Sharma Kitchen Equipment", "29ABHPS9876Q1Z3", "1188", 30),
    "V06": ("UrbanLinen Services", "29AAECU2468R1Z6", "3365", 15),
}
MATRIX_PO_SUBTOTALS = {"PO-1001": "16000", "PO-1002": "15600", "PO-7731": "10000", "PO-1003": "50000",
                       "PO-1004": "8700", "PO-1005": "6000", "PO-1006": "9300", "PO-1007": "9000",
                       "PO-1008": "5200", "PO-1009": "13000"}
MATRIX_PO_VENDOR = {"PO-1001": "V01", "PO-1002": "V02", "PO-7731": "V03", "PO-1003": "V04", "PO-1004": "V05",
                    "PO-1005": "V01", "PO-1006": "V02", "PO-1007": "V05", "PO-1008": "V06", "PO-1009": "V01"}
MATRIX_CATALOG = {"CONT-500": 50, "BAG-M": 100}
# test_id -> dict of figures stated in the matrix (or the approved scenario summary)
MATRIX_FIGURES = {
    "S1": dict(number="FP-2026-0418", po="PO-1001", subtotal="16000", tax="2880", total="18880", date="2026-10-12"),
    "S2": dict(number="CC-7781", po="PO-1002", total="18408", bank4="0091"),
    "S3": dict(number="INV-552", po="7731", subtotal="10200", total="10200"),
    "S4": dict(number="INV-552", po="7731", total="10000", revised=True),
    "S5": dict(number="FP/2026/418", total="18880", date="2026-10-12"),
    "S6a": dict(number="BF-3301", po="PO-1003", total="35400"),
    "S6b": dict(number="BF-3342", po="PO-1003", subtotal="24000", total="28320"),
    "S7": dict(number="SKE-119", po=None, subtotal="8700", total="10266"),
    "S8": dict(number="QS-55", po="PO-2201", total="2950"),
    "S9": dict(number="Q-2026-77", po=None),
    "S10": dict(number="CC-7790", po="PO-1006", subtotal="9300", tax="1674", total="11474", correct_total="10974"),
    "S11": dict(number="FP-2026-0431", po="PO-1005", total="7186.20"),
    "S12": dict(number="SKE-127", po="PO-1007", subtotal="9000", total="10620"),
    "S13": dict(number="UL-882", po="PO-1008", total="6136"),
    "S14": dict(number="FP-2026-0440", po="PO-1009", total="15340"),
    "X1": dict(number="INV-552", po="7731", total="10100", revised=True),
    "X2": dict(number="INV-552", po="7731", total="10000", revised=True),
    "X3": dict(number="CC-7795", po="PO-1006", subtotal="9800", tax="1764", total="11564"),
}
MATRIX_EXPECTED = {  # outcome, blocking, info (min)
    "S1": ("CLEARED", [], ["PRICE_WITHIN_TOLERANCE"]),
    "S2": ("ON_HOLD", ["BANK_DETAILS_CHANGED"], ["PRICE_WITHIN_TOLERANCE"]),
    "S3": ("ON_HOLD", ["PRICE_OVER_TOLERANCE"], []),
    "S4": ("CLEARED", [], ["CORRECTION_OF"]),
    "S5": ("REJECTED", ["DUPLICATE_INVOICE"], []),
    "S6a": ("CLEARED", [], ["PRICE_WITHIN_TOLERANCE"]),
    "S6b": ("ON_HOLD", ["QTY_EXCEEDS_PO", "PO_AMOUNT_EXCEEDED"], []),
    "S7": ("ON_HOLD", ["SCAN_UNVERIFIED"], ["PO_INFERRED"]),
    "S8": ("ON_HOLD", ["VENDOR_UNKNOWN", "SENDER_UNVERIFIED"], []),
    "S9": ("SKIPPED", ["NOT_INVOICE"], []),
    "S10": ("ON_HOLD", ["ARITHMETIC_MISMATCH"], []),
    "S11": ("CLEARED", [], ["PRICE_WITHIN_TOLERANCE"]),
    "S12": ("ON_HOLD", ["BUNDLED_QUANTITY_UNVERIFIED"], []),
    "S13": ("CLEARED", [], ["PRICE_WITHIN_TOLERANCE"]),
    "S14": ("CLEARED", [], ["LINE_MAPPED_AI_VERIFIED", "PRICE_WITHIN_TOLERANCE"]),
    "X1": ("ON_HOLD", ["PRICE_OVER_TOLERANCE"], ["CORRECTION_CANDIDATE_OF"]),
    "X2": ("ON_HOLD", ["CORRECTION_UNCONFIRMED"], []),
    "X3": ("ON_HOLD", ["UNAPPROVED_CHARGE"], []),
}

# Spec v1.2.2 section 9: hold (blocking) codes (unchanged from v1.2.1)
HOLD_CODES = set("""VENDOR_UNKNOWN VENDOR_GSTIN_MISMATCH SENDER_UNVERIFIED BANK_DETAILS_CHANGED POSSIBLE_DOUBLE_BILLING
RELATED_INVOICE_DISPUTE POSSIBLE_DUPLICATE CORRECTION_UNCONFIRMED CLASSIFICATION_CONFLICT CREDIT_NOTE_UNSUPPORTED
EXTRACTION_FAILED MISSING_REQUIRED_FIELD EVIDENCE_NOT_FOUND ARITHMETIC_MISMATCH SCAN_UNVERIFIED TAX_BASIS_UNCLEAR
PO_NOT_FOUND PO_VENDOR_MISMATCH PO_CLOSED PO_AMBIGUOUS UNAPPROVED_CHARGE LINE_UNMAPPED UOM_UNSUPPORTED
TAX_RATE_MISMATCH QTY_EXCEEDS_PO PO_AMOUNT_EXCEEDED PRICE_OVER_TOLERANCE BUNDLED_QUANTITY_UNVERIFIED DATE_INVALID
APPROVAL_LIMIT_EXCEEDED AI_PROPOSAL_REJECTED""".split())

STOPWORDS = {"a", "an", "the", "of", "and", "for", "with", "per", "as", "to", "in"}


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def read_csv(name):
    with open(TD / name, encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def load():
    vendors = {r["vendor_id"]: r for r in read_csv("vendors.csv")}
    catalog = {r["item_code"]: r for r in read_csv("catalog.csv")}
    pos = {r["po_number"]: dict(r, lines=[]) for r in read_csv("purchase_orders.csv")}
    for r in read_csv("po_lines.csv"):
        pos[r["po_number"]]["lines"].append(r)
    settings = json.loads((TD / "settings.json").read_text(encoding="utf-8"))
    answer = json.loads((TD / "answer_key.json").read_text(encoding="utf-8"))
    tests = {t["test_id"]: t for t in answer["tests"]}
    emails = {tid: json.loads((TD / t["email_payload"]).read_text(encoding="utf-8")) for tid, t in tests.items()}
    return vendors, catalog, pos, settings, tests, emails


# ---------------------------------------------------------------------------
# Helpers (independent implementations of spec normalisation rules)
# ---------------------------------------------------------------------------

def norm_number(s: str) -> str:
    out = []
    for t in re.split(r"[^A-Za-z0-9]+", (s or "").upper()):
        if not t:
            continue
        if t.isdigit():
            t = t.lstrip("0") or "0"
        out.append(t)
    return "".join(out)


def norm_po(s: str) -> str:
    n = norm_number(s)
    return n[2:] if n.startswith("PO") else n


def tokens(s: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", (s or "").lower()) if t]


def sig_tokens(s: str) -> set[str]:
    return {t for t in tokens(s) if t not in STOPWORDS}


def norm_text(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def norm_uom(u: str) -> str:
    u = (u or "").strip().lower()
    return u[:-1] if len(u) > 3 and u.endswith("s") and u not in ("pcs",) else u


def is_lump_sum(description: str, uom: str, markers: dict) -> bool:
    """Spec v1.2.2 M5 detection: explicit markers only (phrase in description or unit, or a lump-sum
    unit code). A PO number in the description is never a marker."""
    text = " " + " ".join(tokens(f"{description} {uom}")) + " "
    if any(f" {' '.join(tokens(p))} " in text for p in markers["phrases"]):
        return True
    return norm_text(uom) in {norm_text(u) for u in markers["units"]}


def within_one(a: D, b: D) -> bool:
    return abs(a - b) <= D("1.00")


def gstin_checksum_char(first14: str) -> str:
    chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    total = 0
    for i, ch in enumerate(first14):
        prod = chars.index(ch) * (1 if i % 2 == 0 else 2)
        total += prod // 36 + prod % 36
    return chars[(36 - total % 36) % 36]


def pdf_text(path: Path) -> str:
    with pdfplumber.open(str(path)) as pdf:
        return "\n".join((p.extract_text() or "") for p in pdf.pages)


# ---------------------------------------------------------------------------
# 1. Reference data vs matrix
# ---------------------------------------------------------------------------

def check_reference(vendors, catalog, pos, settings):
    S = "1 Reference data"
    check(S, "6 vendors V01-V06 present", set(vendors) == set(MATRIX_VENDORS), str(sorted(vendors)))
    for vid, (name, gstin, last4, terms) in MATRIX_VENDORS.items():
        v = vendors.get(vid, {})
        ok = (v.get("legal_name", "").startswith(name) and v.get("gstin") == gstin
              and v.get("bank_last4") == last4 and v.get("bank_account", "").endswith(last4)
              and int(v.get("payment_terms_days", -1)) == terms)
        check(S, f"{vid} matches matrix (name, GSTIN, bank last-4, terms)", ok,
              f"{v.get('legal_name')} | {v.get('gstin')} | {v.get('bank_last4')} | {v.get('payment_terms_days')}")
    check(S, "QuickServe not in vendor master",
          all("quickserve" not in (v["legal_name"] + v["aliases"]).lower() for v in vendors.values()))
    check(S, "catalog pack sizes (CONT-500=50, BAG-M=100)",
          {k: int(v["pack_size"]) for k, v in catalog.items()} == MATRIX_CATALOG)
    check(S, "10 POs present", set(pos) == set(MATRIX_PO_SUBTOTALS), str(sorted(pos)))
    for po, sub in MATRIX_PO_SUBTOTALS.items():
        p = pos[po]
        calc = sum(D(l["qty_ordered"]) * D(l["unit_price_pretax"]) for l in p["lines"])
        ok = (calc == D(sub) and D(p["subtotal_pretax"]) == D(sub) and p["vendor_id"] == MATRIX_PO_VENDOR[po]
              and all(l["line_kind"] != "charge" for l in p["lines"]))
        rates = {l["gst_rate"] for l in p["lines"]}
        ok = ok and (rates == {"0"} if po == "PO-7731" else rates == {"0.18"})
        check(S, f"{po}: vendor, subtotal {sub}, GST rate, no charge line", ok, f"calc={calc} rates={rates}")
    check(S, "settings: price tolerance 2%, qty tolerance 0, rounding Rs 1, limit 2,00,000",
          settings["price_tolerance_pct"] == 2.0 and settings["quantity_tolerance_pct"] == 0.0
          and settings["rounding_tolerance_inr"] == 1.0 and settings["approval_limit_inr"] == 200000.0)
    check(S, "lump-sum markers = spec M5 v1.2.2 (phrases 'lump sum', 'lumpsum'; unit LS)",
          settings.get("lump_sum_markers") == {"phrases": ["lump sum", "lumpsum"], "units": ["LS"]},
          str(settings.get("lump_sum_markers")))
    kws = set(settings["charge_keywords"])
    check(S, "charge keyword list = spec M7 list", kws == {
        "delivery", "freight", "transport", "transportation", "handling", "packing", "loading", "unloading",
        "cartage", "courier", "shipping", "surcharge", "service charge", "convenience fee"})


# ---------------------------------------------------------------------------
# 2. Fictional-data checks
# ---------------------------------------------------------------------------

def check_fictional(vendors, settings, emails, tests):
    S = "2 Fictional data"
    all_emails = [s for v in vendors.values() for s in v["registered_senders"].split("|")]
    all_emails += settings["ap_forwarder_allowlist"] + [settings["inbound_address_placeholder"]]
    for e in emails.values():
        all_emails += [e["from"]] + e["to"]
    check(S, "every email address uses the reserved .example TLD",
          all(a.endswith(".example") for a in all_emails), ", ".join(sorted(set(all_emails))))
    check(S, "every IFSC uses fictional bank code EXMP",
          all(v["ifsc"].startswith("EXMP") for v in vendors.values()))
    check(S, "every bank name and address is marked 'Example'",
          all("Example" in v["bank_name"] and "Example" in v["address"] for v in vendors.values()))
    check(S, "phone numbers use invalid subscriber prefix 0 (cannot ring a real line)",
          all(re.fullmatch(r"\+91 80 0\d{3} \d{4}", v["phone"]) for v in vendors.values()))
    report = []
    valid = []
    for vid, v in vendors.items():
        g = v["gstin"]
        if not g:
            report.append(f"{vid}: no GSTIN")
            continue
        fmt = re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]", g) is not None
        pan_ok = g[2:12] == v["pan"]
        cs = gstin_checksum_char(g[:14]) == g[14]
        if cs:
            valid.append(vid)
        report.append(f"{vid}: format={'ok' if fmt else 'BAD'} pan={'ok' if pan_ok else 'BAD'} "
                      f"checksum={'VALID' if cs else 'invalid'}")
        check(S, f"{vid} GSTIN well-formed and embeds the vendor PAN", fmt and pan_ok, g)
    check(S, "GSTIN checksum report (informational: invalid checksum = cannot be a real registration)",
          True, "; ".join(report))
    return valid


# ---------------------------------------------------------------------------
# 3. PDFs, evidence strings, arithmetic
# ---------------------------------------------------------------------------

def check_pdfs(tests):
    S = "3 PDFs and evidence"
    texts = {}
    files = sorted((TD / "invoices").glob("*.pdf"))
    check(S, "exactly 18 PDFs (S1-S14 incl. S6a/S6b, X1-X3)", len(files) == 18, str(len(files)))
    for tid, t in tests.items():
        path = TD / t["file"]
        if not check(S, f"{tid}: file exists", path.exists(), t["file"]):
            continue
        reader = PdfReader(str(path))
        size = path.stat().st_size
        check(S, f"{tid}: 1 page, <= 4 MB", len(reader.pages) == 1 and size <= 4 * 1024 * 1024, f"{size} bytes")
        txt = pdf_text(path)
        texts[tid] = txt
        has_layer = len(txt.strip()) >= 50
        check(S, f"{tid}: text layer {'present' if t['has_text_layer_expected'] else 'absent'} as expected",
              has_layer == t["has_text_layer_expected"], f"{len(txt.strip())} chars")
        if not has_layer:
            fonts = any("/Font" in (p.get("/Resources") or {}) for p in reader.pages)
            check(S, f"{tid}: image-only page (no fonts)", not fonts)
            continue
        ex = t["expected_extraction"]
        nt = norm_text(txt)
        needles = {"invoice/quote number": ex["invoice_number"], "printed total": ex["total"]}
        if ex["po_reference"]:
            needles["PO reference"] = ex["po_reference"]
        if ex["doc_type"] == "invoice":
            needles["bank account last-4"] = ex["bank_account_last4"]
        for k, ln in enumerate(ex["lines"], 1):
            needles[f"line {k} amount"] = ln["amount"]
            needles[f"line {k} rate"] = ln["unit_price"]
        missing = [f"{k}={v}" for k, v in needles.items() if norm_text(v) not in nt]
        check(S, f"{tid}: number, total, PO ref, bank last-4, line rates/amounts all in text layer",
              not missing, "missing: " + ", ".join(missing) if missing else f"{len(needles)} values found")
        check(S, f"{tid}: title '{ex['document_title']}' and label '{ex['number_label']}' in text",
              ex["document_title"].lower() in txt.lower() and ex["number_label"].lower() in txt.lower())
        if ex["revision_marker"]:
            check(S, f"{tid}: 'REVISED' marker printed", "REVISED" in txt)
        check(S, f"{tid}: fictional-document footer printed", "FICTIONAL TEST DOCUMENT" in txt)
    if "S9" in texts:
        check(S, "S9: the word 'invoice' appears nowhere in the document text", "invoice" not in texts["S9"].lower())
    return texts


def check_arithmetic(tests):
    S = "4 Arithmetic and matrix figures"
    for tid, t in tests.items():
        ex = t["expected_extraction"]
        mf = MATRIX_FIGURES[tid]
        lines = ex["lines"]
        line_ok = all(within_one(D(l["qty"]) * D(l["unit_price"]), D(l["amount"])) for l in lines)
        s_lines = sum(D(l["amount"]) for l in lines)
        basis = ex["price_basis"]
        if basis == "exclusive":
            tax_calc = sum(D(l["amount"]) * D(l["gst_rate"]) for l in lines)
            ok_parts = (within_one(s_lines, D(ex["subtotal"])) and within_one(D(ex["cgst"]) + D(ex["sgst"]), D(ex["tax_total"]))
                        and within_one(tax_calc, D(ex["tax_total"])))
            total_ok = within_one(D(ex["subtotal"]) + D(ex["tax_total"]), D(ex["total"]))
        elif basis == "inclusive":
            rate = D(lines[0]["gst_rate"])
            taxable = s_lines / (1 + rate)
            ok_parts = within_one(taxable, D(ex["subtotal"])) and within_one(D(ex["cgst"]) + D(ex["sgst"]), D(ex["tax_total"]))
            total_ok = within_one(s_lines, D(ex["total"])) and within_one(D(ex["subtotal"]) + D(ex["tax_total"]), D(ex["total"]))
        else:
            ok_parts = within_one(s_lines, D(ex["subtotal"])) and D(ex["tax_total"]) == 0
            total_ok = within_one(D(ex["subtotal"]), D(ex["total"]))
        consistent = line_ok and ok_parts and total_ok
        should_fail = tid == "S10"
        check(S, f"{tid}: arithmetic {'inconsistent (intended)' if should_fail else 'consistent'}",
              consistent != should_fail, f"lines={line_ok} parts={ok_parts} total={total_ok} basis={basis}")
        figs_ok = D(ex["total"]) == D(mf["total"]) if "total" in mf else True
        if "subtotal" in mf:
            figs_ok = figs_ok and D(ex["subtotal"]) == D(mf["subtotal"])
        if "tax" in mf:
            figs_ok = figs_ok and D(ex["tax_total"]) == D(mf["tax"])
        if "correct_total" in mf:
            figs_ok = figs_ok and within_one(D(ex["subtotal"]) + D(ex["tax_total"]), D(mf["correct_total"]))
        figs_ok = figs_ok and ex["invoice_number"] == mf["number"] and ex["po_reference"] == mf.get("po", ex["po_reference"])
        if "date" in mf:
            figs_ok = figs_ok and ex["invoice_date"] == mf["date"]
        if "bank4" in mf:
            figs_ok = figs_ok and ex["bank_account_last4"] == mf["bank4"]
        if mf.get("revised"):
            figs_ok = figs_ok and ex["revision_marker"]
        check(S, f"{tid}: number, PO ref and totals equal the matrix figures", figs_ok,
              f"{ex['invoice_number']} total={ex['total']}")
        exp = t["expected"]
        m_out, m_block, m_info = MATRIX_EXPECTED[tid]
        check(S, f"{tid}: answer-key expectation equals the matrix",
              exp["outcome"] == m_out and sorted(exp["blocking"]) == sorted(m_block) and set(m_info) <= set(exp["info"]),
              f"{exp['outcome']} {exp['blocking']} {exp['info']}")


# ---------------------------------------------------------------------------
# 5. Rule oracle
# ---------------------------------------------------------------------------

class Oracle:
    def __init__(self, vendors, catalog, pos, settings, options=None):
        self.vendors, self.catalog, self.pos, self.settings = vendors, catalog, pos, settings
        self.runs = []          # dicts
        self.tokens = {}        # token -> run index
        self.opt = dict(lump_sum_before_m1=True, use_ai_proposals=True)
        self.opt.update(options or {})

    # --- helpers
    def vendor_by_extraction(self, ex):
        g = ex.get("vendor_gstin")
        if g:
            for vid, v in self.vendors.items():
                if v["gstin"] == g:
                    return vid, None
        name = norm_text(ex.get("vendor_name"))
        for vid, v in self.vendors.items():
            names = [v["legal_name"]] + v["aliases"].split("|")
            if any(norm_text(n) == name for n in names):
                if g and v["gstin"] and v["gstin"] != g:
                    return vid, "VENDOR_GSTIN_MISMATCH"
                return vid, None
        return None, "VENDOR_UNKNOWN"

    def consumed(self, po):
        qty, amt = {}, D(0)
        for r in self.runs:
            if r["state"] in ("CLEARED", "APPROVED"):
                for (p, line_no, q, a) in r["consumption"]:
                    if p == po:
                        qty[line_no] = qty.get(line_no, D(0)) + q
                        amt += a
        return qty, amt

    def is_charge(self, desc):
        d = " " + " ".join(tokens(desc)) + " "
        return [k for k in self.settings["charge_keywords"] if f" {k} " in d]

    def m1_map(self, ln, po):
        """Deterministic mapping: item code in description, or all significant PO-description tokens present."""
        inv_toks = set(tokens(ln["description"]))
        hits = []
        for pl in po["lines"]:
            if pl["item_code"] and pl["item_code"].lower() in ln["description"].lower():
                hits.append(pl)
                continue
            if sig_tokens(pl["description"]) and sig_tokens(pl["description"]) <= inv_toks:
                hits.append(pl)
        return hits[0] if len(hits) == 1 else None

    def is_lump_sum(self, ln):
        return is_lump_sum(ln["description"], ln["uom"], self.settings["lump_sum_markers"])

    # --- one run
    def process(self, test, email, has_text_layer, pdf_txt):
        ex = test["expected_extraction"]
        codes, info, notes = [], [], []
        run = dict(test_id=test["test_id"], state="PROCESSING", codes=codes, info=info, notes=notes,
                   consumption=[], vendor_id=None, chain=None, date=ex["invoice_date"], total=D(ex["total"]),
                   lines_sig=json.dumps(ex["lines"], sort_keys=True), linked=None, po=None, po_candidates=None)
        # Stage 0: token parse
        token = None
        m = re.search(r"\[Ref (R-\d+)\]", (email.get("subject") or "") + "\n" + (email.get("body_text") or ""))
        if m:
            token = m.group(1)
        # Stage 2: G1-G3
        title_lbl = (ex["document_title"] + " " + ex["number_label"]).lower()
        invoice_words = ("invoice" in title_lbl) or ("bill of supply" in title_lbl)
        if ex["doc_type"] != "invoice":
            if invoice_words:
                codes.append("CLASSIFICATION_CONFLICT")
            else:
                codes.append("NOT_INVOICE")
                run["state"] = "SKIPPED"
                return self._store(run)
        # Stage 3: V1-V5
        if not all([ex["invoice_number"], ex["invoice_date"], ex["vendor_name"], ex["lines"], ex["total"]]):
            codes.append("MISSING_REQUIRED_FIELD")
        if not self._arith_ok(ex):
            codes.append("ARITHMETIC_MISMATCH")
        if has_text_layer:
            nt = norm_text(pdf_txt)
            need = [ex["invoice_number"], ex["total"]] + ([ex["po_reference"]] if ex["po_reference"] else [])
            if any(norm_text(v) not in nt for v in need):
                codes.append("EVIDENCE_NOT_FOUND")
        else:
            codes.append("SCAN_UNVERIFIED")
        if date.fromisoformat(ex["invoice_date"]) > REF_DATE + timedelta(days=1):
            codes.append("DATE_INVALID")
        # Stage 4: K1-K4
        vid, kcode = self.vendor_by_extraction(ex)
        if kcode:
            codes.append(kcode)
        sender = email["from"]
        allow = self.settings["ap_forwarder_allowlist"]
        registered = vid and sender in self.vendors[vid]["registered_senders"].split("|")
        if not (registered or sender in allow):
            codes.append("SENDER_UNVERIFIED")
        if vid is None:
            notes.append("D, P, M, C and K4 not evaluated (vendor unknown)")
            return self._decide(run)
        run["vendor_id"] = vid
        printed4 = ex.get("bank_account_last4")
        if not printed4:
            info.append("BANK_NOT_SHOWN")
        elif printed4 != self.vendors[vid]["bank_last4"]:
            codes.append("BANK_DETAILS_CHANGED")
        # Stage 5: D1-D4
        chain = (vid, norm_number(ex["invoice_number"]))
        run["chain"] = chain
        earlier = [r for r in self.runs if r["chain"] == chain and r["state"] not in ("FAILED", "SKIPPED")]
        if any(r["date"] == run["date"] and r["total"] == run["total"] for r in earlier):
            codes.append("DUPLICATE_INVOICE")
            run["state"] = "REJECTED"
            return self._store(run)
        holdfam = [r for r in earlier if r["state"] in ("ON_HOLD", "AWAITING_VENDOR")]
        settled = [r for r in earlier if r["state"] in ("CLEARED", "APPROVED", "REJECTED")]
        if holdfam:
            tgt = self.tokens.get(token)
            linked = (tgt is not None and self.runs[tgt]["chain"] == chain and registered)
            run["linked"] = linked
            run["correction_of"] = holdfam
            if not linked:
                codes.append("CORRECTION_UNCONFIRMED")
        elif settled:
            codes.append("POSSIBLE_DOUBLE_BILLING")
        same_vdt = [r for r in self.runs if r["vendor_id"] == vid and r["chain"] != chain and r["date"] == run["date"]
                    and r["total"] == run["total"] and r["state"] not in ("FAILED", "SKIPPED")]
        if same_vdt:
            codes.append("POSSIBLE_DUPLICATE")
        # Stage 6: P1-P2
        vendor_pos = {k: p for k, p in self.pos.items() if p["vendor_id"] == vid and p["status"] == "open"}
        po = None
        if ex["po_reference"]:
            n = norm_po(ex["po_reference"])
            match = [p for k, p in self.pos.items() if norm_po(k) == n]
            if not match:
                codes.append("PO_NOT_FOUND")
            elif match[0]["vendor_id"] != vid:
                codes.append("PO_VENDOR_MISMATCH")
            elif match[0]["status"] != "open":
                codes.append("PO_CLOSED")
            else:
                po = match[0]
        else:
            cands = list(vendor_pos.values())
            if len(cands) > 1:
                cands = [p for p in cands if all(self.m1_map(l, p) for l in ex["lines"])]
            run["po_candidates"] = sorted(vendor_pos)
            if len(cands) == 1:
                po = cands[0]
                info.append("PO_INFERRED")
                notes.append(f"PO inferred: {po['po_number']} (open: {', '.join(sorted(vendor_pos))})")
            elif len(cands) > 1:
                codes.append("PO_AMBIGUOUS")
            else:
                codes.append("PO_NOT_FOUND")
        run["po"] = po["po_number"] if po else None
        if po is None:
            return self._decide(run)
        # Stage 7: M1-M7, T1-T4
        cons_qty, cons_amt = self.consumed(po["po_number"])
        used, mapped = set(), []
        basis = ex["price_basis"]
        for ln in ex["lines"]:
            kws = self.is_charge(ln["description"])
            if kws:
                pcl = [pl for pl in po["lines"] if pl["line_kind"] == "charge" and set(kws) & set(self.is_charge(pl["description"]))]
                if not pcl:
                    codes.append("UNAPPROVED_CHARGE")
                    notes.append(f"charge keyword {kws} on '{ln['description']}', PO has no charge line")
                continue
            if self.opt["lump_sum_before_m1"] and self.is_lump_sum(ln):
                remaining = D(po["subtotal_pretax"]) - cons_amt
                amt = D(ln["amount"]) if basis != "inclusive" else D(ln["amount"]) / (1 + D(ln["gst_rate"]))
                codes.append("BUNDLED_QUANTITY_UNVERIFIED" if amt <= remaining else "PO_AMOUNT_EXCEEDED")
                notes.append(f"bundled line {amt} vs PO remaining {remaining}")
                continue
            pl = self.m1_map(ln, po)
            factor = D(1)
            if pl is not None:
                if norm_uom(ln["uom"]) != norm_uom(pl["uom"]):
                    cat = self.catalog.get(pl["item_code"])
                    if cat and norm_uom(ln["uom"]) == norm_uom(cat["pack_uom"]):
                        factor = D(cat["pack_size"])
                    else:
                        codes.append("UOM_UNSUPPORTED")
                        continue
            elif self.opt["use_ai_proposals"] and test.get("ai_mapping_ground_truth"):
                prop = next((p for p in test["ai_mapping_ground_truth"] if p["invoice_line"] == ln["line_no"]), None)
                pl = next((x for x in po["lines"] if prop and int(x["line_no"]) == prop["proposed_po_line"]), None)
                cat = self.catalog.get(pl["item_code"]) if pl else None
                printed_pack = re.search(r"(?:pack|bundle)\s+of\s+(\d+)", ln["description"].lower())
                ok = (pl is not None and cat is not None and norm_uom(ln["uom"]) == norm_uom(cat["pack_uom"])
                      and prop["pack_size_read"] == int(cat["pack_size"])
                      and printed_pack and int(printed_pack.group(1)) == int(cat["pack_size"]))
                if not ok:
                    codes += ["AI_PROPOSAL_REJECTED", "UOM_UNSUPPORTED"]
                    continue
                factor = D(cat["pack_size"])
                info.append("LINE_MAPPED_AI_VERIFIED")
            else:
                codes.append("LINE_UNMAPPED")
                continue
            if pl["line_no"] in used:
                codes.append("LINE_UNMAPPED")
                continue
            used.add(pl["line_no"])
            if D(ln["gst_rate"]) != D(pl["gst_rate"]):
                codes.append("TAX_RATE_MISMATCH")
            rate = D(ln["unit_price"])
            pre = rate / (1 + D(ln["gst_rate"])) if basis == "inclusive" else rate
            base_qty = D(ln["qty"]) * factor
            base_price = pre / factor
            mapped.append((pl, base_qty, base_price))
        # Stage 8: C1-C5
        mapped_amt = D(0)
        for pl, q, p in mapped:
            po_price = D(pl["unit_price_pretax"])
            if p * 100 > po_price * 102:
                codes.append("PRICE_OVER_TOLERANCE")
            elif p * 100 < po_price * 98:
                info.append("PRICE_BELOW_PO")
            else:
                info.append("PRICE_WITHIN_TOLERANCE")
            if q + cons_qty.get(pl["line_no"], D(0)) > D(pl["qty_ordered"]):
                codes.append("QTY_EXCEEDS_PO")
            mapped_amt += q * p
            run["consumption"].append((po["po_number"], pl["line_no"], q, q * p))
        if mapped and mapped_amt + cons_amt > D(po["subtotal_pretax"]) * D("1.02"):
            codes.append("PO_AMOUNT_EXCEEDED")
        if D(ex["total"]) > D(self.settings["approval_limit_inr"]):
            codes.append("APPROVAL_LIMIT_EXCEEDED")
        notes.append(f"PO {po['po_number']}: mapped pre-tax {mapped_amt} + consumed {cons_amt} vs cap "
                     f"{D(po['subtotal_pretax']) * D('1.02')}")
        return self._decide(run)

    def _arith_ok(self, ex):
        lines = ex["lines"]
        if not all(within_one(D(l["qty"]) * D(l["unit_price"]), D(l["amount"])) for l in lines):
            return False
        s = sum(D(l["amount"]) for l in lines)
        if ex["price_basis"] == "exclusive":
            tax = sum(D(l["amount"]) * D(l["gst_rate"]) for l in lines)
            return (within_one(s, D(ex["subtotal"])) and within_one(tax, D(ex["tax_total"]))
                    and within_one(D(ex["cgst"]) + D(ex["sgst"]), D(ex["tax_total"]))
                    and within_one(D(ex["subtotal"]) + D(ex["tax_total"]), D(ex["total"])))
        if ex["price_basis"] == "inclusive":
            r = D(lines[0]["gst_rate"])
            return (within_one(s, D(ex["total"])) and within_one(s / (1 + r), D(ex["subtotal"]))
                    and within_one(D(ex["subtotal"]) + D(ex["tax_total"]), D(ex["total"])))
        return within_one(s, D(ex["subtotal"])) and within_one(s, D(ex["total"]))

    def _decide(self, run):
        codes = run["codes"]
        hold = [c for c in codes if c in HOLD_CODES]
        if hold:
            run["state"] = "ON_HOLD"
            run["consumption"] = []
        else:
            if run["chain"] and any(r["chain"] == run["chain"] and r["state"] in ("CLEARED", "APPROVED") for r in self.runs):
                codes.append("POSSIBLE_DOUBLE_BILLING")  # P9 guard
                run["state"] = "ON_HOLD"
                run["consumption"] = []
            else:
                run["state"] = "CLEARED"
        # D2 effects
        if run.get("correction_of"):
            if run["linked"] and run["state"] == "CLEARED":
                run["info"].append("CORRECTION_OF")
                for r in run["correction_of"]:
                    r["state"] = "SUPERSEDED"
            else:
                if run["linked"]:
                    run["info"].append("CORRECTION_CANDIDATE_OF")
                for r in run["correction_of"]:
                    if r["state"] == "AWAITING_VENDOR":
                        r["state"] = "ON_HOLD"
        if run["state"] == "CLEARED" and run["vendor_id"]:
            terms = int(self.vendors[run["vendor_id"]]["payment_terms_days"])
            run["due_date"] = (date.fromisoformat(run["date"]) + timedelta(days=terms)).isoformat()
        return self._store(run)

    def _store(self, run):
        self.runs.append(run)
        run["idx"] = len(self.runs) - 1
        return run

    def send_correction(self, test_id):
        r = next(r for r in self.runs if r["test_id"] == test_id)
        assert r["state"] == "ON_HOLD", r["state"]
        r["state"] = "AWAITING_VENDOR"
        tok = f"R-{1000 + r['idx']}"
        self.tokens[tok] = r["idx"]
        return tok

    def state_of(self, test_id):
        return next(r["state"] for r in self.runs if r["test_id"] == test_id)

    def consumed_qty_total(self, po):
        q, _ = self.consumed(po)
        return sum(q.values(), D(0))


def materialise_email(email, issued):
    e = copy.deepcopy(email)
    for tid, tok in issued.items():
        for k in ("subject", "body_text"):
            e[k] = (e.get(k) or "").replace(f"{{{{TOKEN:{tid}}}}}", tok)
    return e


def evaluate(run, exp, before, after_fn):
    """Matrix pass rule: outcome equal, blocking codes exactly equal, expected info present,
    side effects observed (plus due date and inferred PO where declared)."""
    actual_block = sorted({c for c in run["codes"] if c in HOLD_CODES or c in ("NOT_INVOICE", "DUPLICATE_INVOICE")})
    ok_out = run["state"] == exp["outcome"]
    ok_block = actual_block == sorted(exp["blocking"])
    ok_info = set(exp["info"]) <= set(run["info"])
    side_ok, side_detail = True, []
    for se in exp["side_effects"]:
        subj, cond = se.split(":", 1)
        if subj.startswith("PO-"):
            n = D(cond.split("=")[1])
            got = after_fn("po", subj)
            good = got == n
        elif "->" in cond:
            a, b = cond.split("->")
            good = before.get(subj) == a and after_fn("state", subj) == b
            got = f"{before.get(subj)}->{after_fn('state', subj)}"
        elif cond.startswith("not "):
            got = after_fn("state", subj)
            good = got != cond[4:]
        elif cond.startswith("unchanged "):
            st = cond.split(" ", 1)[1]
            got = f"{before.get(subj)}->{after_fn('state', subj)}"
            good = before.get(subj) == st and after_fn("state", subj) == st
        else:
            got = after_fn("state", subj)
            good = got == cond
        side_ok &= good
        side_detail.append(f"{se} [{got}]")
    if exp.get("due_date"):
        side_ok &= run.get("due_date") == exp["due_date"]
        side_detail.append(f"due {run.get('due_date')}")
    if exp.get("expected_po"):
        side_ok &= run.get("po") == exp["expected_po"]
        side_detail.append(f"PO used {run.get('po')}")
    if exp.get("po_candidates_open"):
        side_ok &= run.get("po_candidates") == sorted(exp["po_candidates_open"])
        side_detail.append(f"open POs considered {run.get('po_candidates')}")
    ok = ok_out and ok_block and ok_info and side_ok
    detail = (f"oracle: {run['state']} blocking={actual_block} info={sorted(set(run['info']))}"
              + (f" | {'; '.join(side_detail)}" if side_detail else ""))
    return ok, detail, actual_block


def compare(S, tid, run, exp, before, after_fn, record=True):
    ok, detail, actual_block = evaluate(run, exp, before, after_fn)
    if record:
        check(S, f"{tid}: oracle result matches expected", ok, detail)
    return dict(test_id=tid, state=run["state"], blocking=actual_block, codes=list(run["codes"]),
                info=sorted(set(run["info"])), notes=run["notes"], po=run.get("po"), pass_=ok, detail=detail)


def run_sequence(data, texts, layers, options=None, mutate=None, record=True):
    vendors, catalog, pos, settings, tests, emails = data
    tests = copy.deepcopy(tests)
    emails = copy.deepcopy(emails)
    if mutate:
        mutate(tests, emails)
    S = "5 Rule oracle"
    out = []
    # Scenario sequence (one database)
    o = Oracle(vendors, catalog, pos, settings, options)
    issued = {}
    seq = sorted([t for t in tests.values() if t["group"] == "scenario_sequence"], key=lambda t: t["order"])
    for t in seq:
        tid = t["test_id"]
        before = {r["test_id"]: r["state"] for r in o.runs}
        run = o.process(t, materialise_email(emails[tid], issued), layers[tid], texts.get(tid, ""))
        after = lambda kind, subj: (o.consumed_qty_total(subj) if kind == "po" else o.state_of(subj))
        out.append(compare(S, tid, run, t["expected"], before, after, record))
        if t.get("after_run"):
            issued[tid] = o.send_correction(tid)
            if record:
                check(S, f"{tid}: correction email step -> AWAITING_VENDOR, token {issued[tid]}",
                      o.state_of(tid) == "AWAITING_VENDOR")
    # Isolated tests (fresh database each)
    for t in sorted([t for t in tests.values() if t["group"] == "isolated"], key=lambda t: t["order"]):
        tid = t["test_id"]
        o = Oracle(vendors, catalog, pos, settings, options)
        issued = {}
        setup = t.get("setup") or ""
        if "S3" in setup:
            s3 = tests["S3"]
            o.process(s3, emails["S3"], layers["S3"], texts.get("S3", ""))
            if "correction email" in setup:
                issued["S3"] = o.send_correction("S3")
        before = {r["test_id"]: r["state"] for r in o.runs}
        run = o.process(t, materialise_email(emails[tid], issued), layers[tid], texts.get(tid, ""))
        after = lambda kind, subj, o=o: (o.consumed_qty_total(subj) if kind == "po" else o.state_of(subj))
        out.append(compare(S, tid, run, t["expected"], before, after, record))
    return out


def get(res, tid):
    return next(r for r in res if r["test_id"] == tid)


def mutation_checks(data, texts, layers):
    S = "6 Oracle sensitivity (mutations)"

    # Footnote * : M2 cut -> S14 must become ON_HOLD LINE_UNMAPPED
    res = run_sequence(data, texts, layers, options=dict(use_ai_proposals=False), record=False)
    r = get(res, "S14")
    check(S, "without AI mapping (matrix footnote *), S14 -> ON_HOLD LINE_UNMAPPED",
          r["state"] == "ON_HOLD" and "LINE_UNMAPPED" in r["codes"], f"{r['state']} {r['codes']}")

    # Footnote ** : no token -> S4 must become ON_HOLD CORRECTION_UNCONFIRMED and S3 not superseded
    def drop_token(tests, emails):
        emails["S4"]["subject"] = "Revised invoice INV-552"
        emails["S4"]["body_text"] = "Please find the revised invoice attached."
    res = run_sequence(data, texts, layers, mutate=drop_token, record=False)
    r = get(res, "S4")
    check(S, "S4 without token (matrix footnote **) -> ON_HOLD CORRECTION_UNCONFIRMED",
          r["state"] == "ON_HOLD" and r["codes"] == ["CORRECTION_UNCONFIRMED"], f"{r['state']} {r['codes']}")

    # Token from an unregistered sender must not link
    def wrong_sender(tests, emails):
        emails["S4"]["from"] = "someone@unknown.example"
    res = run_sequence(data, texts, layers, mutate=wrong_sender, record=False)
    r = get(res, "S4")
    check(S, "S4 token from unregistered sender does not link (ON_HOLD, CORRECTION_UNCONFIRMED)",
          r["state"] == "ON_HOLD" and "CORRECTION_UNCONFIRMED" in r["codes"], f"{r['state']} {r['codes']}")

    # Boundary: S11 at +2.01% must hold
    def s11_over(tests, emails):
        ln = tests["S11"]["expected_extraction"]["lines"][0]
        ln["unit_price"] = "3.0603"
    res = run_sequence(data, texts, layers, mutate=s11_over, record=False)
    r = get(res, "S11")
    check(S, "S11 price 3.0603 (+2.01%) -> PRICE_OVER_TOLERANCE (C1 boundary)",
          "PRICE_OVER_TOLERANCE" in r["codes"], f"{r['state']} {r['codes']}")


def lump_sum_checks(data, texts, layers):
    """Spec v1.2.2 M5: explicit markers only; detection runs before M1."""
    S = "7 Lump-sum rule (M5) regression"
    settings = data[3]
    markers = settings["lump_sum_markers"]
    cases = [
        ("Exhaust hood and duct cleaning as per PO-1007 (lump sum)", "LS", True, "S12 line: marker phrase + LS unit"),
        ("Annual kitchen maintenance - Lump-Sum", "job", True, "hyphenated marker"),
        ("Hood cleaning LUMPSUM", "job", True, "one-word marker, upper case"),
        ("Kitchen deep clean", "LS", True, "LS unit alone"),
        ("LPG cylinder 19 kg commercial (refill) as per PO-1003", "cyl", False, "ordinary line citing a PO number"),
        ("Food container 500 ml - PO-1001 line 1", "pcs", False, "ordinary line citing PO and line number"),
        ("Exhaust hood and duct cleaning as per PO-1007", "job", False, "multi-service wording + PO number, no marker"),
        ("Carry bag medium - bundle of 100", "bundle", False, "catalog pack wording ('bundle') is not a marker"),
        ("Duct cleaning", "job", False, "plain service line"),
    ]
    for desc, uom, want, why in cases:
        got = is_lump_sum(desc, uom, markers)
        check(S, f"detect('{desc}', unit {uom}) = {want}  [{why}]", got == want, f"got {got}")

    # Full-run regression: an ordinary line citing its PO number is mapped normally.
    def s6a_cites_po(tests, emails):
        tests["S6a"]["expected_extraction"]["lines"][0]["description"] = \
            "LPG cylinder 19 kg commercial (refill) as per PO-1003"
    res = run_sequence(data, texts, layers, mutate=s6a_cites_po, record=False)
    a, b = get(res, "S6a"), get(res, "S6b")
    check(S, "S6a line 'as per PO-1003' still maps normally: CLEARED, consumes 15, no lump-sum code",
          a["pass_"] and "BUNDLED_QUANTITY_UNVERIFIED" not in a["codes"], a["detail"])
    check(S, "...and S6b downstream is unchanged (QTY_EXCEEDS_PO, PO_AMOUNT_EXCEEDED)", b["pass_"], b["detail"])

    def s1_cites_po(tests, emails):
        tests["S1"]["expected_extraction"]["lines"][0]["description"] = "Food container 500 ml (round, PP) - PO-1001"
    r = get(run_sequence(data, texts, layers, mutate=s1_cites_po, record=False), "S1")
    check(S, "S1 line '- PO-1001' still maps normally: CLEARED", r["pass_"] and r["state"] == "CLEARED", r["detail"])

    # S12 as generated: lump-sum
    r = get(run_sequence(data, texts, layers, record=False), "S12")
    check(S, "S12 as generated: ON_HOLD BUNDLED_QUANTITY_UNVERIFIED", r["pass_"], r["detail"])

    # Ordering is load-bearing: if M1 ran first, S12 would be mapped to 'Duct cleaning'.
    r = get(run_sequence(data, texts, layers, options=dict(lump_sum_before_m1=False), record=False), "S12")
    check(S, "ordering is load-bearing: with M1 first, S12 would differ (so S12 catches a wrong order)",
          not r["pass_"], f"M1-first result: {r['state']} {r['codes']}")

    # Without markers, the same wording is not lump-sum: normal mapping, still held (fail safe), never cleared.
    def s12_no_marker(tests, emails):
        ln = tests["S12"]["expected_extraction"]["lines"][0]
        ln["description"] = "Exhaust hood and duct cleaning as per PO-1007"
        ln["uom"] = "job"
    r = get(run_sequence(data, texts, layers, mutate=s12_no_marker, record=False), "S12")
    check(S, "S12 wording without a marker: not lump-sum, still ON_HOLD (fail safe), never CLEARED",
          r["state"] == "ON_HOLD" and "BUNDLED_QUANTITY_UNVERIFIED" not in r["codes"], f"{r['state']} {r['codes']}")


# --- S7: extraction accuracy (field by field) -------------------------------------------------
NUM_FIELDS = {"subtotal", "cgst", "sgst", "tax_total", "total", "qty", "unit_price", "amount", "gst_rate"}
TEXT_FIELDS = {"vendor_name", "description"}


def field_equal(name, a, b):
    if a is None or b is None:
        return a is None and b is None
    if name in NUM_FIELDS:
        try:
            return D(str(a)) == D(str(b))
        except Exception:
            return False
    if name in TEXT_FIELDS:
        return tokens(str(a)) == tokens(str(b))
    return re.sub(r"\s", "", str(a)).upper() == re.sub(r"\s", "", str(b)).upper()


def extraction_diffs(expected, actual, fields):
    diffs = []
    for f in fields:
        if f.startswith("lines[]."):
            k = f.split(".", 1)[1]
            el, al = expected["lines"], actual.get("lines") or []
            if len(el) != len(al):
                diffs.append(f"line count: got {len(al)}, expected {len(el)}")
                continue
            for i, (e, a) in enumerate(zip(el, al), 1):
                if not field_equal(k, e.get(k), a.get(k)):
                    diffs.append(f"line {i} {k}: got {a.get(k)!r}, expected {e.get(k)!r}")
        elif not field_equal(f, expected.get(f), actual.get(f)):
            diffs.append(f"{f}: got {actual.get(f)!r}, expected {expected.get(f)!r}")
    return list(dict.fromkeys(diffs))


def s7_checks(data, texts, layers):
    S = "8 S7 scan: intended hold, PO inference, extraction errors not accepted"
    tests = data[4]
    t = tests["S7"]
    exp_ex = t["expected_extraction"]
    fields = t["critical_fields"]
    check(S, "S7 answer key declares PO-1004 inferred from open {PO-1004, PO-1007} and lists critical fields",
          t["expected"].get("expected_po") == "PO-1004" and t["expected"].get("po_candidates_open") == ["PO-1004", "PO-1007"]
          and bool(fields) and t["expected"].get("extraction_accuracy_required") is True, f"{len(fields or [])} fields")
    check(S, "S7 has no PO reference in the ground truth", exp_ex["po_reference"] is None)

    def s7_overall(mut=None):
        def m(tests, emails):
            if mut:
                mut(tests["S7"]["expected_extraction"])
        res = run_sequence(data, texts, layers, mutate=m, record=False)
        r = get(res, "S7")
        actual = copy.deepcopy(exp_ex)
        if mut:
            mut(actual)
        diffs = extraction_diffs(exp_ex, actual, fields)
        return r, diffs, (r["pass_"] and not diffs)

    r, diffs, ok = s7_overall()
    check(S, "correct extraction: S7 passes (SCAN_UNVERIFIED only, PO_INFERRED -> PO-1004, 0 field diffs)",
          ok, r["detail"] + f" | field diffs: {len(diffs)}")

    misreads = [
        ("GSTIN Q read as 0 (29ABHPS987601Z3)", lambda e: e.__setitem__("vendor_gstin", "29ABHPS987601Z3")),
        ("unit 'pcs' read as 'pes'", lambda e: e["lines"][1].__setitem__("uom", "pes")),
        ("line 1 amount 6,000 read as 6,800", lambda e: e["lines"][0].__setitem__("amount", "6800.00")),
        ("PO reference hallucinated (PO-1007)", lambda e: e.__setitem__("po_reference", "PO-1007")),
        ("date 15/10 read as 16/10 (no rule fires)", lambda e: e.__setitem__("invoice_date", "2026-10-16")),
        ("bank account last-4 1188 read as 1186", lambda e: e.__setitem__("bank_account_last4", "1186")),
    ]
    for name, mut in misreads:
        r, diffs, ok = s7_overall(mut)
        why = []
        if not r["pass_"]:
            why.append(f"outcome check fails ({r['state']} {r['blocking']})")
        if diffs:
            why.append(f"field check fails ({'; '.join(diffs)})")
        check(S, f"misread rejected, not silently accepted: {name}", not ok, " and ".join(why) or "ACCEPTED")


OCR_DPIS = (100, 150, 200, 300)
OCR_PSMS = (3, 4, 6)


def ocr_sweep(tests):
    """Legibility proxy: plain tesseract over 4 resolutions x 3 page-segmentation modes.
    Row integrity is judged only in psm 4/6, which preserve rows; psm 3 splits table columns by design."""
    S = "9 S7 scan legibility (tesseract proxy; not the production extractor)"
    if not (shutil.which("tesseract") and shutil.which("pdftoppm")):
        check(S, "OCR sweep", None, "SKIPPED: tesseract/pdftoppm not installed; legibility not verified on this machine")
        return
    t = tests["S7"]
    ex = t["expected_extraction"]
    N = lambda s: re.sub(r"[^A-Z0-9]", "", str(s).upper())
    d = ex["invoice_date"]
    fields = {
        "vendor name": lambda L: any(N(ex["vendor_name"]) in N(l) for l in L),
        "title": lambda L: any(N(ex["document_title"]) in N(l) for l in L),
        "vendor GSTIN (exact)": lambda L: any(N(ex["vendor_gstin"]) in N(l) for l in L),
        "invoice number": lambda L: any(N(ex["invoice_number"]) in N(l) for l in L),
        "date": lambda L: any(N(d[8:10] + d[5:7] + d[0:4]) in N(l) for l in L),
        "subtotal": lambda L: any("SUBTOTAL" in N(l) and N(ex["subtotal"]) in N(l) for l in L),
        "CGST": lambda L: any("CGST" in N(l) and N(ex["cgst"]) in N(l) for l in L),
        "SGST": lambda L: any("SGST" in N(l) and N(ex["sgst"]) in N(l) for l in L),
        "total": lambda L: any("TOTAL" in N(l) and N(ex["total"]) in N(l) for l in L),
        "bank account (last-4 " + ex["bank_account_last4"] + ")": lambda L: any(
            re.search(r"\d{10,}" + ex["bank_account_last4"] + r"\b", re.sub(r"\s", "", l)) for l in L),
        "no PO reference printed": lambda L: not any(re.search(r"\bP\.?\s?O\b", l.upper()) for l in L),
    }
    for k, ln in enumerate(ex["lines"], 1):
        vals = [N(ln["description"]), N(ln["uom"]), N(ln["unit_price"]), N(ln["amount"])]
        q = ln["qty"]
        fields[f"line {k} values present"] = (lambda vals: lambda L: all(v in N(" ".join(L)) for v in vals))(vals)
        fields[f"line {k} row integrity (desc, qty, unit, rate, amount on one row)"] = (
            lambda vals, q: lambda L: any(all(v in N(l) for v in vals) and re.search(rf"\b{q}\b", l) for l in L))(vals, q)
    misses = {}
    with tempfile.TemporaryDirectory() as tmp:
        for dpi in OCR_DPIS:
            subprocess.run(["pdftoppm", "-r", str(dpi), "-png", "-singlefile", str(TD / t["file"]), f"{tmp}/p{dpi}"],
                           check=True)
            for psm in OCR_PSMS:
                txt = subprocess.run(["tesseract", f"{tmp}/p{dpi}.png", "-", "--psm", str(psm)],
                                     capture_output=True, text=True).stdout
                L = [l for l in txt.splitlines() if l.strip()]
                for name, f in fields.items():
                    if "row integrity" in name and psm == 3:
                        continue
                    if not f(L):
                        misses.setdefault(name, []).append(f"{dpi}dpi/psm{psm}")
    for name in fields:
        n_cfg = len(OCR_DPIS) * (len(OCR_PSMS) - 1 if "row integrity" in name else len(OCR_PSMS))
        miss = misses.get(name, [])
        check(S, f"{name}: read correctly in {n_cfg - len(miss)}/{n_cfg} OCR configurations", not miss,
              ("missed: " + ", ".join(miss)) if miss else "")


def main():
    data = load()
    vendors, catalog, pos, settings, tests, emails = data
    check_reference(vendors, catalog, pos, settings)
    valid_gstins = check_fictional(vendors, settings, emails, tests)
    texts = check_pdfs(tests)
    layers = {tid: len(texts.get(tid, "").strip()) >= 50 for tid in tests}
    check_arithmetic(tests)
    S = "5 Rule oracle"
    for tid, e in emails.items():
        ok = e["attachments"][0]["path"] == tests[tid]["file"] and bool(e["from"])
        if tests[tid].get("reply_token_of"):
            ok = ok and f"{{{{TOKEN:{tests[tid]['reply_token_of']}}}}}" in e["subject"]
        check(S, f"{tid}: email payload references its PDF{' and carries token placeholder' if tests[tid].get('reply_token_of') else ''}", ok)
    oracle_results = run_sequence(data, texts, layers)
    mutation_checks(data, texts, layers)
    lump_sum_checks(data, texts, layers)
    s7_checks(data, texts, layers)
    ocr_sweep(tests)

    # Report
    out = []
    cur = None
    for sec, name, ok, detail in results:
        if sec != cur:
            out.append(f"\n## {sec}")
            cur = sec
        tag = "SKIP" if ok is None else ("PASS" if ok else "FAIL")
        out.append(f"[{tag}] {name}" + (f"  -- {detail}" if detail else ""))
    fails = [r for r in results if r[2] is False]
    skips = [r for r in results if r[2] is None]
    summary = (f"\nTOTAL: {len(results)} checks, {len(results) - len(fails) - len(skips)} passed, "
               f"{len(fails)} failed, {len(skips)} skipped")
    out.append(summary)
    if valid_gstins:
        out.append(f"NOTE: GSTINs with a VALID checksum (could coincide with a real registration): {valid_gstins}")
    text = "\n".join(out)
    print(text)
    (TD / "validation_report.txt").write_text(text + "\n", encoding="utf-8")
    (TD / "oracle_results.json").write_text(json.dumps(oracle_results, indent=2, default=str), encoding="utf-8")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
