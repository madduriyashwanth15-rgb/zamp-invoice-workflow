"""
Zamp PS-1 test data generator (v2).

Generates fictional reference data, invoice PDFs and an answer key that match
claude/test-matrix.md v1.2.2 and claude/workflow-spec.md v1.2.2.

Everything is fictional. Company names, GSTINs, PANs, bank accounts, IFSC codes,
addresses, phone numbers and email addresses are invented. Email domains use the
reserved ".example" TLD. Any resemblance to a real entity is coincidental.

Run:  python scripts/generate_test_data.py
Needs: reportlab, Pillow (pip install reportlab pillow)

This is test-data tooling, not application code.
"""

from __future__ import annotations

import csv
import json
import random
from dataclasses import dataclass, field
from datetime import date, timedelta
import time
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import simpleSplit
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test-data"
PDF_DIR = OUT / "invoices"
EMAIL_DIR = OUT / "emails"

D = Decimal
TWO = D("0.01")


def money(x) -> Decimal:
    return D(str(x)).quantize(TWO, rounding=ROUND_HALF_UP)


def inr(x) -> str:
    """Indian digit grouping, 2 decimals: 123456.5 -> 1,23,456.50"""
    x = money(x)
    neg = x < 0
    s = f"{abs(x):.2f}"
    whole, frac = s.split(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups + [tail])
    return ("-" if neg else "") + whole + "." + frac


ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
        "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
        "Eighteen", "Nineteen"]
TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _words_below_1000(n: int) -> str:
    parts = []
    if n >= 100:
        parts.append(ONES[n // 100] + " Hundred")
        n %= 100
    if n >= 20:
        parts.append(TENS[n // 10] + ((" " + ONES[n % 10]) if n % 10 else ""))
    elif n > 0:
        parts.append(ONES[n])
    return " ".join(parts)


def amount_in_words(x) -> str:
    x = money(x)
    rupees = int(x)
    paise = int((x - rupees) * 100)
    parts = []
    lakh, rem = divmod(rupees, 100000)
    thousand, rem = divmod(rem, 1000)
    if lakh:
        parts.append(_words_below_1000(lakh) + " Lakh")
    if thousand:
        parts.append(_words_below_1000(thousand) + " Thousand")
    if rem:
        parts.append(_words_below_1000(rem))
    text = "Rupees " + (" ".join(parts) if parts else "Zero")
    if paise:
        text += " and " + _words_below_1000(paise) + " Paise"
    return text + " Only"


# ---------------------------------------------------------------------------
# Reference data (trusted master, fictional)
# ---------------------------------------------------------------------------

BUYER = {
    "name": "SpiceRoute Kitchens Pvt Ltd",
    "address": ["No. 45, 2nd Cross, Example Layout", "Koramangala, Bengaluru 560034, Karnataka"],
    "gstin": "29AAJCS2468K1Z1",
}

AP_FORWARDER_ALLOWLIST = ["ap-forwarder@spiceroute.example"]
INBOUND_ADDRESS = "invoices@inbound.spiceroute.example"
UNREGISTERED_SENDER = "billing@quickserve.example"

VENDORS = {
    "V01": dict(name="FreshPack Packaging Pvt Ltd", aliases=["FreshPack", "FreshPack Packaging"],
                gstin="29AAFCF1234K1Z5", pan="AAFCF1234K", bank_account="50200012344417",
                bank_name="Example Urban Co-operative Bank", ifsc="EXMP0001234", terms=30,
                senders=["billing@freshpack.example"],
                address=["Plot 12, Example Industrial Area, Peenya", "Bengaluru 560058, Karnataka"],
                phone="+91 80 0000 1001"),
    "V02": dict(name="CleanCo Hygiene Supplies", aliases=["CleanCo", "CleanCo Hygiene"],
                gstin="29AAGCC5678M1Z2", pan="AAGCC5678M", bank_account="60110045672290",
                bank_name="Example City Bank", ifsc="EXMP0005678", terms=30,
                senders=["accounts@cleanco.example"],
                address=["14, Example Market Road, Jayanagar", "Bengaluru 560041, Karnataka"],
                phone="+91 80 0000 1002"),
    "V03": dict(name="Kumar Vegetables", aliases=["Kumar Veg", "Kumar Vegetable Suppliers"],
                gstin="", pan="ABCPK7781Q", bank_account="30987654327781",
                bank_name="Example Rural Bank", ifsc="EXMP0007781", terms=7,
                senders=["kumarveg@mail.example"],
                address=["Stall 22, Example Wholesale Market, K.R. Market", "Bengaluru 560002"],
                phone="+91 80 0000 7781"),
    "V04": dict(name="BlueFlame Gas Supplies", aliases=["BlueFlame", "BlueFlame Gas"],
                gstin="29AABCB4321P1Z8", pan="AABCB4321P", bank_account="40112233445530",
                bank_name="Example Urban Co-operative Bank", ifsc="EXMP0004321", terms=15,
                senders=["billing@blueflame.example"],
                address=["Godown 3, Example Gas Depot Road, Hebbal", "Bengaluru 560024, Karnataka"],
                phone="+91 80 0000 1004"),
    "V05": dict(name="Sharma Kitchen Equipment", aliases=["Sharma Kitchen", "Sharma Kitchen Equip."],
                gstin="29ABHPS9876Q1Z3", pan="ABHPS9876Q", bank_account="20334455661188",
                bank_name="Example City Bank", ifsc="EXMP0009876", terms=30,
                senders=["service@sharmakitchen.example"],
                address=["88, Example Service Lane, Shivajinagar", "Bengaluru 560051, Karnataka"],
                phone="+91 80 0000 1005"),
    "V06": dict(name="UrbanLinen Services", aliases=["UrbanLinen", "Urban Linen"],
                gstin="29AAECU2468R1Z6", pan="AAECU2468R", bank_account="70556677883365",
                bank_name="Example Urban Co-operative Bank", ifsc="EXMP0002468", terms=15,
                senders=["billing@urbanlinen.example"],
                address=["5, Example Laundry Park, HSR Layout", "Bengaluru 560102, Karnataka"],
                phone="+91 80 0000 1006"),
}

# Not in the vendor master (used only by S8)
UNKNOWN_VENDOR = dict(name="QuickServe Traders", gstin="29AAKCQ1357S1Z9",
                      bank_account="11122233344455", bank_name="Example Private Bank",
                      ifsc="EXMP0001357", address=["Unit 9, Example Trade Centre", "Bengaluru 560001"],
                      phone="+91 80 0000 9999")

CATALOG = [
    dict(item_code="CONT-500", description="Food container 500 ml", base_uom="pcs", pack_uom="pack", pack_size=50),
    dict(item_code="BAG-M", description="Carry bag medium", base_uom="pcs", pack_uom="bundle", pack_size=100),
]

# po_number -> (vendor_id, po_date, [lines]); line = (line_no, item_code, kind, description, uom, qty, unit_price, gst_rate)
POS = {
    "PO-1001": ("V01", date(2026, 10, 5), [
        (1, "CONT-500", "goods", "Food container 500 ml", "pcs", 2000, "6.50", "0.18"),
        (2, "BAG-M", "goods", "Carry bag medium", "pcs", 1000, "3.00", "0.18")]),
    "PO-1002": ("V02", date(2026, 10, 6), [
        (1, "", "goods", "Floor cleaner 5 L can", "can", 20, "450.00", "0.18"),
        (2, "", "goods", "Dishwash liquid 1 L", "bottle", 30, "220.00", "0.18")]),
    "PO-7731": ("V03", date(2026, 10, 14), [
        (1, "", "goods", "Onions", "kg", 200, "30.00", "0"),
        (2, "", "goods", "Tomatoes", "kg", 100, "40.00", "0")]),
    "PO-1003": ("V04", date(2026, 10, 3), [
        (1, "", "goods", "LPG cylinder 19 kg commercial", "cyl", 25, "2000.00", "0.18")]),
    "PO-1004": ("V05", date(2026, 10, 7), [
        (1, "", "service", "Burner servicing", "visit", 4, "1500.00", "0.18"),
        (2, "", "goods", "Gas hose replacement", "pcs", 6, "450.00", "0.18")]),
    "PO-1005": ("V01", date(2026, 10, 9), [
        (1, "BAG-M", "goods", "Carry bag medium", "pcs", 2000, "3.00", "0.18")]),
    "PO-1006": ("V02", date(2026, 10, 8), [
        (1, "", "goods", "Glass cleaner 500 ml", "bottle", 40, "120.00", "0.18"),
        (2, "", "goods", "Garbage bag roll", "roll", 50, "90.00", "0.18")]),
    "PO-1007": ("V05", date(2026, 10, 10), [
        (1, "", "service", "Exhaust hood deep cleaning", "visit", 2, "3500.00", "0.18"),
        (2, "", "service", "Duct cleaning", "job", 1, "2000.00", "0.18")]),
    "PO-1008": ("V06", date(2026, 10, 9), [
        (1, "", "service", "Napkin laundry", "pcs", 500, "8.00", "0.18"),
        (2, "", "service", "Apron laundry", "pcs", 100, "12.00", "0.18")]),
    "PO-1009": ("V01", date(2026, 10, 12), [
        (1, "CONT-500", "goods", "Food container 500 ml", "pcs", 2000, "6.50", "0.18")]),
}

SETTINGS = {
    "price_tolerance_pct": 2.0,
    "quantity_tolerance_pct": 0.0,
    "rounding_tolerance_inr": 1.0,
    "approval_limit_inr": 200000.0,
    "ap_forwarder_allowlist": AP_FORWARDER_ALLOWLIST,
    "charge_keywords": ["delivery", "freight", "transport", "transportation", "handling", "packing",
                        "loading", "unloading", "cartage", "courier", "shipping", "surcharge",
                        "service charge", "convenience fee"],
    # Spec v1.2.2 M5: explicit lump-sum markers, matched on normalised tokens (case-insensitive;
    # "Lump-Sum" and "lump sum" both match). A PO number in the description is NOT a marker.
    "lump_sum_markers": {"phrases": ["lump sum", "lumpsum"], "units": ["LS"]},
    "currency": "INR",
    "buyer": BUYER,
    "inbound_address_placeholder": INBOUND_ADDRESS,
}


# ---------------------------------------------------------------------------
# Invoice definitions
# ---------------------------------------------------------------------------

@dataclass
class Line:
    desc: str
    hsn: str
    qty: Decimal
    uom: str
    rate: Decimal
    gst: Decimal          # rate as fraction, e.g. 0.18
    amount: Decimal | None = None   # computed if None


@dataclass
class Doc:
    test_id: str
    filename: str
    layout: str            # A, B, C, D, SCAN
    vendor_id: str | None  # None = unknown vendor (uses UNKNOWN_VENDOR)
    title: str
    number_label: str
    number: str
    inv_date: date
    date_fmt: str
    po_label: str | None
    po_ref: str | None
    lines: list[Line]
    tax_mode: str          # exclusive | inclusive | none
    doc_type: str = "invoice"
    bank_override: str | None = None
    total_override: Decimal | None = None
    stamp: str | None = None
    notes: list[str] = field(default_factory=list)
    terms_text: str | None = None
    validity_text: str | None = None


def L(desc, hsn, qty, uom, rate, gst="0.18"):
    return Line(desc, hsn, D(str(qty)), uom, D(str(rate)), D(gst))


DOCS: list[Doc] = [
    Doc("S1", "S01_FreshPack_FP-2026-0418.pdf", "A", "V01", "TAX INVOICE", "Invoice No.", "FP-2026-0418",
        date(2026, 10, 12), "%d/%m/%Y", "PO No.", "PO-1001",
        [L("Food container 500 ml (round, PP)", "3923", 2000, "pcs", "6.50"),
         L("Carry bag medium (printed)", "3923", 1000, "pcs", "3.00")], "exclusive"),
    Doc("S2", "S02_CleanCo_CC-7781.pdf", "B", "V02", "TAX INVOICE", "Invoice #", "CC-7781",
        date(2026, 10, 14), "%d-%b-%Y", "Ref PO", "PO-1002",
        [L("Floor cleaner 5 L can - citrus", "3402", 20, "can", "450.00"),
         L("Dishwash liquid 1 L", "3402", 30, "bottle", "220.00")], "exclusive",
        bank_override="60110045670091"),
    Doc("S3", "S03_Kumar_INV-552.pdf", "C", "V03", "INVOICE", "Bill No.", "INV-552",
        date(2026, 10, 16), "%d.%m.%Y", "PO", "7731",
        [L("Onions (Nashik)", "0703", 200, "kg", "30.00", "0"),
         L("Tomatoes", "0702", 100, "kg", "42.00", "0")], "none",
        notes=["Fresh vegetables - exempt from GST."]),
    Doc("S4", "S04_Kumar_INV-552_REVISED.pdf", "C", "V03", "INVOICE", "Bill No.", "INV-552",
        date(2026, 10, 18), "%d.%m.%Y", "PO", "7731",
        [L("Onions (Nashik)", "0703", 200, "kg", "30.00", "0"),
         L("Tomatoes", "0702", 100, "kg", "40.00", "0")], "none", stamp="REVISED",
        notes=["Fresh vegetables - exempt from GST.", "Revised bill as per your mail. Tomato rate corrected."]),
    Doc("S5", "S05_FreshPack_FP-2026-418_reprint.pdf", "A", "V01", "TAX INVOICE", "Invoice No.", "FP/2026/418",
        date(2026, 10, 12), "%d/%m/%Y", "PO No.", "PO-1001",
        [L("Food container 500 ml (round, PP)", "3923", 2000, "pcs", "6.50"),
         L("Carry bag medium (printed)", "3923", 1000, "pcs", "3.00")], "exclusive",
        notes=["Duplicate copy for your records."]),
    Doc("S6a", "S06a_BlueFlame_BF-3301.pdf", "A", "V04", "TAX INVOICE", "Invoice No.", "BF-3301",
        date(2026, 10, 10), "%d/%m/%Y", "PO No.", "PO-1003",
        [L("LPG cylinder 19 kg commercial (refill)", "2711", 15, "cyl", "2000.00")], "exclusive"),
    Doc("S6b", "S06b_BlueFlame_BF-3342.pdf", "A", "V04", "TAX INVOICE", "Invoice No.", "BF-3342",
        date(2026, 10, 17), "%d/%m/%Y", "PO No.", "PO-1003",
        [L("LPG cylinder 19 kg commercial (refill)", "2711", 12, "cyl", "2000.00")], "exclusive"),
    Doc("S7", "S07_Sharma_SKE-119_SCANNED.pdf", "SCAN", "V05", "TAX INVOICE", "Invoice No.", "SKE-119",
        date(2026, 10, 15), "%d/%m/%Y", None, None,
        [L("Burner servicing - 4 burner range", "9987", 4, "visit", "1500.00"),
         L("Gas hose replacement (1.5 m)", "4009", 6, "pcs", "450.00")], "exclusive"),
    Doc("S8", "S08_QuickServe_QS-55.pdf", "B", None, "TAX INVOICE", "Invoice #", "QS-55",
        date(2026, 10, 16), "%d-%b-%Y", "Ref PO", "PO-2201",
        [L("Kitchen towel rolls", "4818", 100, "roll", "25.00")], "exclusive"),
    Doc("S9", "S09_FreshPack_Q-2026-77_QUOTATION.pdf", "A", "V01", "QUOTATION", "Quote No.", "Q-2026-77",
        date(2026, 10, 13), "%d/%m/%Y", None, None,
        [L("Food container 750 ml (round, PP)", "3923", 3000, "pcs", "7.20"),
         L("Carry bag large (printed)", "3923", 2000, "pcs", "4.10")], "exclusive", doc_type="quotation",
        validity_text="Valid until 15/11/2026. Prices subject to confirmation on order.",
        terms_text="This quotation is not a demand for payment."),
    Doc("S10", "S10_CleanCo_CC-7790.pdf", "B", "V02", "TAX INVOICE", "Invoice #", "CC-7790",
        date(2026, 10, 15), "%d-%b-%Y", "Ref PO", "PO-1006",
        [L("Glass cleaner 500 ml spray", "3402", 40, "bottle", "120.00"),
         L("Garbage bag roll - large", "3923", 50, "roll", "90.00")], "exclusive",
        total_override=D("11474.00")),
    Doc("S11", "S11_FreshPack_FP-2026-0431.pdf", "A", "V01", "TAX INVOICE", "Invoice No.", "FP-2026-0431",
        date(2026, 10, 19), "%d/%m/%Y", "PO No.", "PO-1005",
        [L("Carry bag medium (printed)", "3923", 2000, "pcs", "3.045")], "exclusive"),
    Doc("S12", "S12_Sharma_SKE-127_LUMPSUM.pdf", "A", "V05", "TAX INVOICE", "Invoice No.", "SKE-127",
        date(2026, 10, 19), "%d/%m/%Y", "PO No.", "PO-1007",
        [L("Exhaust hood and duct cleaning as per PO-1007 (lump sum)", "9987", 1, "LS", "9000.00")], "exclusive"),
    Doc("S13", "S13_UrbanLinen_UL-882_INCLUSIVE.pdf", "D", "V06", "TAX INVOICE", "Invoice No.", "UL-882",
        date(2026, 10, 17), "%d %b %Y", "PO Ref", "PO-1008",
        [L("Napkin laundry (cotton)", "9997", 500, "pcs", "9.44"),
         L("Apron laundry", "9997", 100, "pcs", "14.16")], "inclusive",
        notes=["All prices are inclusive of GST @ 18%."]),
    Doc("S14", "S14_FreshPack_FP-2026-0440_PACKS.pdf", "A", "V01", "TAX INVOICE", "Invoice No.", "FP-2026-0440",
        date(2026, 10, 20), "%d/%m/%Y", "PO No.", "PO-1009",
        [L("Takeaway box 500cc - Pack of 50", "3923", 40, "pack", "325.00")], "exclusive"),
    Doc("X1", "X1_Kumar_INV-552_REVISED_still_high.pdf", "C", "V03", "INVOICE", "Bill No.", "INV-552",
        date(2026, 10, 18), "%d.%m.%Y", "PO", "7731",
        [L("Onions (Nashik)", "0703", 200, "kg", "30.00", "0"),
         L("Tomatoes", "0702", 100, "kg", "41.00", "0")], "none", stamp="REVISED",
        notes=["Fresh vegetables - exempt from GST.", "Revised bill as per your mail."]),
    Doc("X2", "X2_Kumar_INV-552_REVISED_no_token.pdf", "C", "V03", "INVOICE", "Bill No.", "INV-552",
        date(2026, 10, 18), "%d.%m.%Y", "PO", "7731",
        [L("Onions (Nashik)", "0703", 200, "kg", "30.00", "0"),
         L("Tomatoes", "0702", 100, "kg", "40.00", "0")], "none", stamp="REVISED",
        notes=["Fresh vegetables - exempt from GST.", "Revised bill. Tomato rate corrected."]),
    Doc("X3", "X3_CleanCo_CC-7795_DELIVERY.pdf", "B", "V02", "TAX INVOICE", "Invoice #", "CC-7795",
        date(2026, 10, 20), "%d-%b-%Y", "Ref PO", "PO-1006",
        [L("Glass cleaner 500 ml spray", "3402", 40, "bottle", "120.00"),
         L("Garbage bag roll - large", "3923", 50, "roll", "90.00"),
         L("Delivery charges", "9965", 1, "job", "500.00")], "exclusive"),
]

# Expected outcomes transcribed from claude/test-matrix.md v1.2.2 (declared, not computed).
EXPECTED = {
    "S1": dict(outcome="CLEARED", blocking=[], info=["PRICE_WITHIN_TOLERANCE"], side_effects=[],
               due_date="2026-11-11"),
    "S2": dict(outcome="ON_HOLD", blocking=["BANK_DETAILS_CHANGED"], info=["PRICE_WITHIN_TOLERANCE"], side_effects=[]),
    "S3": dict(outcome="ON_HOLD", blocking=["PRICE_OVER_TOLERANCE"], info=[], side_effects=[]),
    "S4": dict(outcome="CLEARED", blocking=[], info=["CORRECTION_OF"], side_effects=["S3:SUPERSEDED"]),
    "S5": dict(outcome="REJECTED", blocking=["DUPLICATE_INVOICE"], info=[], side_effects=[]),
    "S6a": dict(outcome="CLEARED", blocking=[], info=["PRICE_WITHIN_TOLERANCE"], side_effects=["PO-1003:consumed_qty=15"]),
    "S6b": dict(outcome="ON_HOLD", blocking=["QTY_EXCEEDS_PO", "PO_AMOUNT_EXCEEDED"], info=[], side_effects=[]),
    "S7": dict(outcome="ON_HOLD", blocking=["SCAN_UNVERIFIED"], info=["PO_INFERRED"], side_effects=[],
               expected_po="PO-1004", po_candidates_open=["PO-1004", "PO-1007"],
               extraction_accuracy_required=True,
               note="Pass needs exactly SCAN_UNVERIFIED, PO_INFERRED to PO-1004, and every critical field "
                    "equal to expected_extraction (see critical_fields). Any misread is a failure, even if "
                    "the outcome is still ON_HOLD."),
    "S8": dict(outcome="ON_HOLD", blocking=["VENDOR_UNKNOWN", "SENDER_UNVERIFIED"], info=[], side_effects=[]),
    "S9": dict(outcome="SKIPPED", blocking=["NOT_INVOICE"], info=[], side_effects=[]),
    "S10": dict(outcome="ON_HOLD", blocking=["ARITHMETIC_MISMATCH"], info=[], side_effects=[]),
    "S11": dict(outcome="CLEARED", blocking=[], info=["PRICE_WITHIN_TOLERANCE"], side_effects=["PO-1005:consumed_qty=2000"]),
    "S12": dict(outcome="ON_HOLD", blocking=["BUNDLED_QUANTITY_UNVERIFIED"], info=[], side_effects=[],
                note="Detected as lump-sum by explicit markers ('lump sum' in the description; unit LS) before "
                     "M1. The PO number in the description is not what makes it lump-sum."),
    "S13": dict(outcome="CLEARED", blocking=[], info=["PRICE_WITHIN_TOLERANCE"], side_effects=[]),
    "S14": dict(outcome="CLEARED", blocking=[], info=["LINE_MAPPED_AI_VERIFIED", "PRICE_WITHIN_TOLERANCE"],
                side_effects=[], note="Assumes AI mapping proposal (M2) is built; otherwise ON_HOLD LINE_UNMAPPED, changed before running."),
    "X1": dict(outcome="ON_HOLD", blocking=["PRICE_OVER_TOLERANCE"], info=["CORRECTION_CANDIDATE_OF"],
               side_effects=["S3:AWAITING_VENDOR->ON_HOLD", "S3:not SUPERSEDED"]),
    "X2": dict(outcome="ON_HOLD", blocking=["CORRECTION_UNCONFIRMED"], info=[], side_effects=["S3:unchanged ON_HOLD"]),
    "X3": dict(outcome="ON_HOLD", blocking=["UNAPPROVED_CHARGE"], info=[], side_effects=[]),
}

# Fields compared one by one against expected_extraction when extraction_accuracy_required is set.
# Rule: amounts, quantities and rates compare numerically; identifiers compare after removing spaces and
# case; descriptions compare on normalised tokens; po_reference must be absent (null).
CRITICAL_FIELDS = ["doc_type", "vendor_name", "vendor_gstin", "invoice_number", "invoice_date", "po_reference",
                   "price_basis", "lines[].description", "lines[].qty", "lines[].uom", "lines[].unit_price",
                   "lines[].amount", "lines[].gst_rate", "subtotal", "cgst", "sgst", "tax_total", "total",
                   "bank_account_last4"]

# Run plan: path, sender, group, order and setup
RUN_PLAN = {
    "S1": dict(group="scenario_sequence", order=1, path="email", sender="registered"),
    "S2": dict(group="scenario_sequence", order=2, path="email", sender="registered"),
    "S3": dict(group="scenario_sequence", order=3, path="email", sender="registered",
               after="Send correction email for S3 (S3 -> AWAITING_VENDOR, token issued)"),
    "S4": dict(group="scenario_sequence", order=4, path="email", sender="registered", reply_token_of="S3"),
    "S5": dict(group="scenario_sequence", order=5, path="email", sender="registered"),
    "S6a": dict(group="scenario_sequence", order=6, path="email", sender="registered"),
    "S6b": dict(group="scenario_sequence", order=7, path="email", sender="registered"),
    "S7": dict(group="scenario_sequence", order=8, path="email", sender="registered"),
    "S8": dict(group="scenario_sequence", order=9, path="email", sender="unregistered"),
    "S9": dict(group="scenario_sequence", order=10, path="email", sender="registered"),
    "S10": dict(group="scenario_sequence", order=11, path="email", sender="registered"),
    "S11": dict(group="scenario_sequence", order=12, path="email", sender="registered"),
    "S12": dict(group="scenario_sequence", order=13, path="email", sender="registered"),
    "S13": dict(group="scenario_sequence", order=14, path="email", sender="registered"),
    "S14": dict(group="scenario_sequence", order=15, path="email", sender="registered"),
    "X1": dict(group="isolated", order=1, path="email", sender="registered", reply_token_of="S3",
               setup="Fresh database: process S3, then send correction email (S3 AWAITING_VENDOR, token issued)"),
    "X2": dict(group="isolated", order=2, path="email", sender="registered",
               setup="Fresh database: process S3 (ON_HOLD). Fresh email, no token"),
    "X3": dict(group="isolated", order=3, path="email", sender="registered", setup="Fresh database"),
}

# Ground-truth AI mapping proposals (only where deterministic mapping M1 is expected to fail)
AI_MAPPING_GROUND_TRUTH = {
    "S14": [dict(invoice_line=1, proposed_po_line=1, pack_size_read=50,
                 justification="Takeaway box 500cc is the 500 ml food container; sold in packs of 50.")],
}


# ---------------------------------------------------------------------------
# Computation of printed figures
# ---------------------------------------------------------------------------

def compute(doc: Doc) -> dict:
    lines = []
    for i, ln in enumerate(doc.lines, 1):
        amt = money(ln.qty * ln.rate) if ln.amount is None else money(ln.amount)
        lines.append(dict(line_no=i, description=ln.desc, hsn_sac=ln.hsn, qty=(str(int(ln.qty)) if ln.qty == ln.qty.to_integral() else str(ln.qty)),
                          uom=ln.uom, unit_price=str(ln.rate), amount=str(amt), gst_rate=str(ln.gst),
                          _amt=amt, _gst=ln.gst))
    res = dict(lines=lines)
    if doc.tax_mode == "exclusive":
        subtotal = money(sum(l["_amt"] for l in lines))
        tax = money(sum(l["_amt"] * l["_gst"] for l in lines))
        cgst = money(tax / 2)
        sgst = money(tax - cgst)
        total = money(subtotal + tax)
        res.update(subtotal=subtotal, cgst=cgst, sgst=sgst, tax_total=tax, total=total, price_basis="exclusive")
    elif doc.tax_mode == "inclusive":
        total = money(sum(l["_amt"] for l in lines))
        rate = lines[0]["_gst"]
        taxable = money(total / (1 + rate))
        tax = money(total - taxable)
        cgst = money(tax / 2)
        sgst = money(tax - cgst)
        res.update(subtotal=taxable, cgst=cgst, sgst=sgst, tax_total=tax, total=total, price_basis="inclusive")
    else:
        subtotal = money(sum(l["_amt"] for l in lines))
        res.update(subtotal=subtotal, cgst=money(0), sgst=money(0), tax_total=money(0), total=subtotal, price_basis="none")
    res["computed_total"] = res["total"]
    if doc.total_override is not None:
        res["total"] = money(doc.total_override)
    return res


def vendor_block(doc: Doc) -> dict:
    v = VENDORS[doc.vendor_id] if doc.vendor_id else UNKNOWN_VENDOR
    acct = doc.bank_override or v["bank_account"]
    return dict(name=v["name"], address=v["address"], gstin=v.get("gstin", ""), phone=v["phone"],
                bank_name=v["bank_name"], ifsc=v["ifsc"], bank_account=acct)


# ---------------------------------------------------------------------------
# PDF rendering (reportlab)
# ---------------------------------------------------------------------------

W, H = A4


def _right(c, x, y, text):
    c.drawRightString(x, y, text)


def draw_table(c, doc, figs, top, x0=40, x1=None, header_fill=colors.HexColor("#EEF2F7"),
               font="Helvetica", bold="Helvetica-Bold", size=9, show_gst=True):
    x1 = x1 or (W - 40)
    cols = [x0, x0 + 24, x0 + 250, x0 + 300, x0 + 350, x0 + 385, x0 + 445]
    heads = ["#", "Description", "HSN/SAC", "Qty", "Unit", "Rate", "Amount"]
    row_h = 18
    c.setFillColor(header_fill)
    c.rect(x0, top - row_h, x1 - x0, row_h, fill=1, stroke=0)
    c.setFillColor(colors.black)
    c.setFont(bold, size)
    for i, h in enumerate(heads):
        if i in (3, 5, 6):
            _right(c, (cols[i + 1] - 6) if i + 1 < len(cols) else x1 - 6, top - 12, h)
        else:
            c.drawString(cols[i] + 4, top - 12, h)
    y = top - row_h
    c.setFont(font, size)
    desc_w = cols[2] - cols[1] - 8
    for ln in figs["lines"]:
        wrapped = simpleSplit(ln["description"], font, size, desc_w)
        h = max(row_h, 11 * len(wrapped) + 7)
        y -= h
        c.drawString(cols[0] + 4, y + h - 12, str(ln["line_no"]))
        for k, part in enumerate(wrapped):
            c.drawString(cols[1] + 4, y + h - 12 - 11 * k, part)
        y_text = y + h - 12
        c.drawString(cols[2] + 4, y_text, ln["hsn_sac"])
        _right(c, cols[4] - 6, y_text, fmt_qty(ln["qty"]))
        c.drawString(cols[4] + 4, y_text, ln["uom"])
        _right(c, cols[6] - 6, y_text, inr(D(ln["unit_price"])) if D(ln["unit_price"]) == money(D(ln["unit_price"])) else f"{D(ln['unit_price']):.3f}")
        _right(c, x1 - 6, y_text, inr(D(ln["amount"])))
        c.setStrokeColor(colors.HexColor("#D5DBE3"))
        c.line(x0, y, x1, y)
    c.setStrokeColor(colors.HexColor("#9AA5B1"))
    c.rect(x0, y, x1 - x0, top - y, fill=0, stroke=1)
    return y


def fmt_qty(q: str) -> str:
    d = D(q)
    if d == d.to_integral():
        return f"{int(d):,}"
    return str(d)


def draw_totals(c, doc, figs, y, x1=None, font="Helvetica", bold="Helvetica-Bold", size=9):
    x1 = x1 or (W - 40)
    lx = x1 - 210
    rows = []
    if doc.tax_mode == "exclusive":
        rows = [("Sub Total", inr(figs["subtotal"])),
                ("CGST @ 9%", inr(figs["cgst"])),
                ("SGST @ 9%", inr(figs["sgst"]))]
        total_label = "Total (INR)"
    elif doc.tax_mode == "inclusive":
        rows = [("Taxable value", inr(figs["subtotal"])),
                ("GST included @ 18%", inr(figs["tax_total"])),
                ("  of which CGST 9%", inr(figs["cgst"])),
                ("  of which SGST 9%", inr(figs["sgst"]))]
        total_label = "Total incl. GST (INR)"
    else:
        rows = [("Sub Total", inr(figs["subtotal"]))]
        total_label = "Total (Rs.)"
    c.setFont(font, size)
    for label, val in rows:
        y -= 15
        c.drawString(lx, y, label)
        _right(c, x1 - 6, y, val)
    y -= 20
    c.setFont(bold, size + 2)
    c.drawString(lx, y, total_label)
    _right(c, x1 - 6, y, inr(figs["total"]))
    return y


def draw_bank_and_words(c, doc, figs, vb, y, font="Helvetica", size=8.5):
    c.setFont(font, size)
    y -= 26
    c.drawString(40, y, "Amount in words: " + amount_in_words(figs["total"]))
    if doc.doc_type == "invoice":
        y -= 22
        c.setFont("Helvetica-Bold", size)
        c.drawString(40, y, "Bank details for payment")
        c.setFont(font, size)
        y -= 13
        c.drawString(40, y, f"Account name: {vb['name']}")
        y -= 12
        c.drawString(40, y, f"A/c No.: {vb['bank_account']}    IFSC: {vb['ifsc']}    Bank: {vb['bank_name']}")
    return y


def draw_footer(c, doc, y, size=8):
    c.setFont("Helvetica", size)
    if doc.vendor_id:
        terms = VENDORS[doc.vendor_id]["terms"]
    else:
        terms = 30
    if doc.doc_type == "invoice":
        y -= 22
        c.drawString(40, y, f"Payment terms: {terms} days from invoice date.")
    for n in doc.notes:
        y -= 13
        c.drawString(40, y, n)
    if doc.validity_text:
        y -= 13
        c.drawString(40, y, doc.validity_text)
    if doc.terms_text:
        y -= 13
        c.drawString(40, y, doc.terms_text)
    c.setFont("Helvetica-Oblique", 7)
    c.setFillColor(colors.HexColor("#6B7280"))
    c.drawString(40, 28, "FICTIONAL TEST DOCUMENT - generated for software testing. Not a real company or transaction.")
    c.setFillColor(colors.black)


def draw_stamp(c, text):
    c.saveState()
    c.setFillColor(colors.HexColor("#C0392B"))
    c.setStrokeColor(colors.HexColor("#C0392B"))
    c.translate(W - 152, H - 162)
    c.setLineWidth(2)
    c.rect(-8, -8, 112, 30, fill=0, stroke=1)
    c.setFont("Helvetica-Bold", 20)
    c.drawString(0, 0, text)
    c.restoreState()


def render_layout_a(c, doc, figs, vb):
    # Corporate header band
    c.setFillColor(colors.HexColor("#1F3A5F"))
    c.rect(0, H - 90, W, 90, fill=1, stroke=0)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(40, H - 42, vb["name"])
    c.setFont("Helvetica", 8.5)
    c.drawString(40, H - 57, ", ".join(vb["address"]))
    c.drawString(40, H - 70, f"GSTIN: {vb['gstin']}    Phone: {vb['phone']}")
    c.setFont("Helvetica-Bold", 18)
    _right(c, W - 40, H - 45, doc.title)
    c.setFillColor(colors.black)
    y = H - 115
    c.setFont("Helvetica-Bold", 9)
    c.drawString(40, y, "Bill To")
    c.setFont("Helvetica", 9)
    c.drawString(40, y - 13, BUYER["name"])
    c.drawString(40, y - 25, BUYER["address"][0])
    c.drawString(40, y - 37, BUYER["address"][1])
    c.drawString(40, y - 49, f"GSTIN: {BUYER['gstin']}")
    meta = [(doc.number_label, doc.number), ("Date", doc.inv_date.strftime(doc.date_fmt))]
    if doc.po_label and doc.po_ref:
        meta.append((doc.po_label, doc.po_ref))
    meta.append(("Place of supply", "Karnataka (29)"))
    my = y
    for k, v in meta:
        c.setFont("Helvetica-Bold", 9)
        c.drawString(W - 250, my, k)
        c.setFont("Helvetica", 9)
        c.drawString(W - 150, my, v)
        my -= 14
    top = y - 75
    yb = draw_table(c, doc, figs, top)
    yt = draw_totals(c, doc, figs, yb)
    yw = draw_bank_and_words(c, doc, figs, vb, yt)
    draw_footer(c, doc, yw)
    c.setFont("Helvetica", 8.5)
    _right(c, W - 40, 80, f"For {vb['name']}")
    _right(c, W - 40, 62, "Authorised Signatory")


def render_layout_b(c, doc, figs, vb):
    # Left-aligned brand, boxed meta on right, green accent
    accent = colors.HexColor("#1E7F5C")
    c.setStrokeColor(accent)
    c.setLineWidth(3)
    c.line(40, H - 40, W - 40, H - 40)
    c.setFont("Helvetica-Bold", 15)
    c.setFillColor(accent)
    c.drawString(40, H - 65, vb["name"].upper())
    c.setFillColor(colors.black)
    c.setFont("Helvetica", 8.5)
    c.drawString(40, H - 79, vb["address"][0])
    c.drawString(40, H - 91, vb["address"][1])
    c.drawString(40, H - 103, f"GSTIN {vb['gstin']}  |  {vb['phone']}")
    c.setFont("Helvetica-Bold", 20)
    _right(c, W - 40, H - 68, doc.title)
    c.setLineWidth(0.8)
    c.rect(W - 230, H - 175, 190, 62, fill=0, stroke=1)
    c.setFont("Helvetica", 9)
    rows = [(doc.number_label, doc.number), ("Invoice date", doc.inv_date.strftime(doc.date_fmt))]
    if doc.po_label and doc.po_ref:
        rows.append((doc.po_label, doc.po_ref))
    ry = H - 128
    for k, v in rows:
        c.drawString(W - 222, ry, k)
        _right(c, W - 48, ry, v)
        ry -= 16
    c.setFont("Helvetica-Bold", 9)
    c.drawString(40, H - 130, "Billed to:")
    c.setFont("Helvetica", 9)
    c.drawString(40, H - 143, BUYER["name"])
    c.drawString(40, H - 155, BUYER["address"][0])
    c.drawString(40, H - 167, BUYER["address"][1])
    c.drawString(40, H - 179, f"GSTIN {BUYER['gstin']}")
    yb = draw_table(c, doc, figs, H - 205, header_fill=colors.HexColor("#E3F2EC"))
    yt = draw_totals(c, doc, figs, yb)
    yw = draw_bank_and_words(c, doc, figs, vb, yt)
    draw_footer(c, doc, yw)
    c.setFont("Helvetica", 8.5)
    c.drawString(40, 70, "Thank you for your business.")


def render_layout_c(c, doc, figs, vb):
    # Simple small-vendor bill, Courier
    c.setFont("Courier-Bold", 16)
    c.drawCentredString(W / 2, H - 50, vb["name"].upper())
    c.setFont("Courier", 9)
    c.drawCentredString(W / 2, H - 64, vb["address"][0])
    c.drawCentredString(W / 2, H - 76, vb["address"][1] + "   Ph: " + vb["phone"])
    c.setFont("Courier-Bold", 13)
    c.drawCentredString(W / 2, H - 100, doc.title)
    c.setFont("Courier", 10)
    c.drawString(40, H - 128, f"{doc.number_label} {doc.number}")
    _right(c, W - 40, H - 128, f"Date: {doc.inv_date.strftime(doc.date_fmt)}")
    c.drawString(40, H - 144, f"To: {BUYER['name']}, Koramangala")
    if doc.po_label and doc.po_ref:
        c.drawString(40, H - 160, f"{doc.po_label}: {doc.po_ref}")
    if doc.stamp:
        draw_stamp(c, doc.stamp)
    yb = draw_table(c, doc, figs, H - 180, header_fill=colors.HexColor("#F2F2F2"),
                    font="Courier", bold="Courier-Bold", size=9)
    yt = draw_totals(c, doc, figs, yb, font="Courier", bold="Courier-Bold")
    yw = draw_bank_and_words(c, doc, figs, vb, yt, font="Courier")
    draw_footer(c, doc, yw)
    c.setFont("Courier", 9)
    _right(c, W - 40, 70, "Signature: ____________")


def render_layout_d(c, doc, figs, vb):
    # Minimal modern, Times
    c.setFont("Times-Bold", 20)
    c.drawString(40, H - 55, vb["name"])
    c.setFont("Times-Roman", 9.5)
    c.drawString(40, H - 70, ", ".join(vb["address"]))
    c.drawString(40, H - 83, f"GSTIN {vb['gstin']}")
    c.setFont("Times-Bold", 14)
    _right(c, W - 40, H - 55, doc.title)
    c.setFont("Times-Roman", 10)
    _right(c, W - 40, H - 72, f"{doc.number_label} {doc.number}")
    _right(c, W - 40, H - 86, doc.inv_date.strftime(doc.date_fmt))
    if doc.po_label and doc.po_ref:
        _right(c, W - 40, H - 100, f"{doc.po_label}: {doc.po_ref}")
    c.setStrokeColor(colors.HexColor("#999999"))
    c.line(40, H - 112, W - 40, H - 112)
    c.setFont("Times-Roman", 10)
    c.drawString(40, H - 130, f"Client: {BUYER['name']}, {BUYER['address'][1]}  (GSTIN {BUYER['gstin']})")
    yb = draw_table(c, doc, figs, H - 150, header_fill=colors.HexColor("#F4F1EA"),
                    font="Times-Roman", bold="Times-Bold", size=10)
    yt = draw_totals(c, doc, figs, yb, font="Times-Roman", bold="Times-Bold", size=10)
    yw = draw_bank_and_words(c, doc, figs, vb, yt, font="Times-Roman")
    draw_footer(c, doc, yw)


RENDERERS = {"A": render_layout_a, "B": render_layout_b, "C": render_layout_c, "D": render_layout_d}


def render_pdf(doc: Doc, figs: dict, path: Path):
    vb = vendor_block(doc)
    c = canvas.Canvas(str(path), pagesize=A4, invariant=1)
    c.setTitle(f"{doc.title} {doc.number}")
    c.setAuthor("Fictional test data generator")
    RENDERERS[doc.layout](c, doc, figs, vb)
    c.showPage()
    c.save()


# ---------------------------------------------------------------------------
# Scanned invoice (Pillow): image-only PDF, no text layer
# ---------------------------------------------------------------------------

FONT_DIR = Path(__file__).resolve().parent / "fonts"


def _font(size, bold=False):
    """Bundled DejaVu Sans Condensed (Bitstream Vera licence, see fonts/DEJAVU-LICENSE.txt)."""
    name = "DejaVuSansCondensed-Bold.ttf" if bold else "DejaVuSansCondensed.ttf"
    return ImageFont.truetype(str(FONT_DIR / name), size)


SCAN_DPI = 200
SCAN_W, SCAN_H = 1654, 2339          # A4 at 200 dpi
SCAN_TILT_DEG = 0.9


def render_scan(doc: Doc, figs: dict, path: Path):
    """Image-only scan. Outcome-critical fields (vendor, GSTIN, number, date, line rows,
    totals, bank account) are set at >= 38 px (about 13.7 pt at 200 dpi) so they stay
    legible when the page is downsampled; secondary text is smaller."""
    vb = vendor_block(doc)
    img = Image.new("RGB", (SCAN_W, SCAN_H), "white")
    d = ImageDraw.Draw(img)
    F_TITLE, F_NAME = _font(58, True), _font(48, True)
    F, F_B = _font(40), _font(40, True)            # critical fields
    F_S, F_SB = _font(32), _font(32, True)         # secondary text
    F_TOT = _font(46, True)
    ink = (20, 20, 24)
    L, R = 90, SCAN_W - 90
    F_H = _font(34, True)                       # table headers

    def right(x, y, text, font):
        d.text((x - d.textlength(text, font=font), y), text, font=font, fill=ink)

    # Header
    d.text((L, 95), vb["name"].upper(), font=F_NAME, fill=ink)
    right(R, 92, doc.title, F_TITLE)
    d.text((L, 162), vb["address"][0], font=F_S, fill=ink)
    d.text((L, 202), vb["address"][1], font=F_S, fill=ink)
    d.text((L, 248), f"GSTIN: {vb['gstin']}", font=F_B, fill=ink)
    d.text((L + 640, 252), f"Phone: {vb['phone']}", font=F_S, fill=ink)
    d.line((L, 315, R, 315), fill=ink, width=3)
    # Bill to (secondary) and invoice meta (critical)
    d.text((L, 345), "Bill To:", font=F_SB, fill=ink)
    d.text((L, 385), BUYER["name"], font=F_S, fill=ink)
    d.text((L, 422), BUYER["address"][0], font=F_S, fill=ink)
    d.text((L, 459), BUYER["address"][1], font=F_S, fill=ink)
    d.text((L, 496), f"GSTIN: {BUYER['gstin']}", font=F_S, fill=ink)
    mx = 1010
    d.rectangle((mx - 30, 338, R, 548), outline=ink, width=2)
    d.text((mx, 362), f"{doc.number_label} {doc.number}", font=F_B, fill=ink)
    d.text((mx, 420), f"Date: {doc.inv_date.strftime(doc.date_fmt)}", font=F, fill=ink)
    d.text((mx, 478), "Place of supply: Karnataka (29)", font=F_S, fill=ink)

    # Line table with measured columns; fail loudly instead of overlapping.
    heads = ["#", "Description", "HSN/SAC", "Qty", "Unit", "Rate", "Amount"]
    rows = [[str(ln["line_no"]), ln["description"], ln["hsn_sac"], fmt_qty(ln["qty"]), ln["uom"],
             inr(D(ln["unit_price"])), inr(D(ln["amount"]))] for ln in figs["lines"]]
    pad = 16
    widths = [max(d.textlength(h, font=F_H), *(d.textlength(r[i], font=F) for r in rows)) + 2 * pad
              for i, h in enumerate(heads)]
    spare = (R - L) - sum(widths)
    if spare < 0:
        raise ValueError(f"scan table overflows page width by {-spare:.0f} px")
    widths[1] += spare                      # description column takes the slack
    xs = [L]
    for wdt in widths:
        xs.append(xs[-1] + wdt)
    numeric = {0, 3, 5, 6}
    top, hh, rh = 600, 70, 78
    d.rectangle((L, top, R, top + hh), outline=ink, width=3)
    for i, h in enumerate(heads):
        if i in numeric:
            right(xs[i + 1] - pad, top + 14, h, F_H)
        else:
            d.text((xs[i] + pad, top + 14), h, font=F_H, fill=ink)
    y = top + hh
    for r in rows:
        d.rectangle((L, y, R, y + rh), outline=ink, width=2)
        for i, val in enumerate(r):
            if i in numeric:
                right(xs[i + 1] - pad, y + 12, val, F)
            else:
                d.text((xs[i] + pad, y + 12), val, font=F, fill=ink)
        y += rh

    # Totals (critical)
    y += 40
    lx = 1010
    for label, val in [("Sub Total", figs["subtotal"]), ("CGST @ 9%", figs["cgst"]), ("SGST @ 9%", figs["sgst"])]:
        d.text((lx, y), label, font=F, fill=ink)
        right(R - pad, y, inr(val), F)
        y += 56
    y += 10
    d.text((lx, y), "Total (INR)", font=F_TOT, fill=ink)
    right(R - pad, y, inr(figs["total"]), F_TOT)
    y += 100
    d.text((L, y), "Amount in words: " + amount_in_words(figs["total"]), font=F_S, fill=ink)
    # Bank (critical: account number)
    y += 75
    d.text((L, y), "Bank details for payment", font=F_SB, fill=ink)
    d.text((L, y + 48), f"A/c No.: {vb['bank_account']}", font=F_B, fill=ink)
    d.text((L, y + 104), f"IFSC: {vb['ifsc']}    Bank: {vb['bank_name']}", font=F_S, fill=ink)
    d.text((L, y + 146), f"Account name: {vb['name']}", font=F_S, fill=ink)
    d.text((L, y + 205), f"Payment terms: {VENDORS[doc.vendor_id]['terms']} days from invoice date.", font=F_S, fill=ink)
    right(R, 2060, f"For {vb['name']}", F_S)
    right(R, 2110, "Authorised Signatory", F_S)
    d.text((L, 2230), "FICTIONAL TEST DOCUMENT - generated for software testing.", font=_font(28), fill=(95, 95, 95))

    # Scan effects: slight tilt, mild blur, grain, greyscale, scanner shadow on the left edge.
    rng = random.Random(1907)
    img = img.convert("L")
    img = img.rotate(SCAN_TILT_DEG, resample=Image.BICUBIC, expand=False, fillcolor=255)
    img = img.filter(ImageFilter.GaussianBlur(radius=0.7))
    px = img.load()
    w, h = img.size
    for _ in range(70000):
        x, yy = rng.randrange(w), rng.randrange(h)
        px[x, yy] = max(0, min(255, px[x, yy] + rng.randint(-55, 25)))
    sw = 80
    shade = Image.linear_gradient("L").rotate(90).resize((sw, h))
    shade = shade.point(lambda v: 255 - int(v * 0.25))
    img.paste(Image.composite(img.crop((0, 0, sw, h)), shade, Image.new("L", (sw, h), 200)), (0, 0))
    fixed = time.strptime("2026-10-15 10:00:00", "%Y-%m-%d %H:%M:%S")
    img.save(path, "PDF", resolution=float(SCAN_DPI), creationDate=fixed, modDate=fixed)


# ---------------------------------------------------------------------------
# Writers
# ---------------------------------------------------------------------------

def write_csv(path, header, rows):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        w.writerows(rows)


def expected_extraction(doc: Doc, figs: dict) -> dict:
    vb = vendor_block(doc)
    return {
        "doc_type": doc.doc_type,
        "document_title": doc.title,
        "number_label": doc.number_label,
        "invoice_number": doc.number,
        "invoice_date": doc.inv_date.isoformat(),
        "vendor_name": vb["name"],
        "vendor_gstin": vb["gstin"] or None,
        "buyer_name": BUYER["name"],
        "po_reference": doc.po_ref,
        "price_basis": figs["price_basis"],
        "lines": [{k: v for k, v in ln.items() if not k.startswith("_")} for ln in figs["lines"]],
        "subtotal": str(figs["subtotal"]),
        "cgst": str(figs["cgst"]),
        "sgst": str(figs["sgst"]),
        "tax_total": str(figs["tax_total"]),
        "total": str(figs["total"]),
        "bank_account_last4": vb["bank_account"][-4:],
        "revision_marker": doc.stamp == "REVISED",
        "currency": "INR",
    }


def email_payload(doc: Doc, plan: dict) -> dict:
    v = VENDORS.get(doc.vendor_id) if doc.vendor_id else None
    sender = v["senders"][0] if (plan["sender"] == "registered" and v) else UNREGISTERED_SENDER
    token_of = plan.get("reply_token_of")
    if token_of:
        subject = f"Re: Correction required for invoice {doc.number} [Ref {{{{TOKEN:{token_of}}}}}]"
        body = ("Dear Sir/Madam,\n\nPlease find the revised invoice attached as requested.\n\n"
                f"> [Ref {{{{TOKEN:{token_of}}}}}]\n> Your earlier message requested a corrected invoice.\n\nRegards")
    elif doc.stamp == "REVISED":
        subject = f"Revised invoice {doc.number}"
        body = "Dear Sir/Madam,\n\nPlease find our revised invoice attached.\n\nRegards"
    elif doc.doc_type == "quotation":
        subject = f"Quotation {doc.number} for containers and bags"
        body = "Dear Sir/Madam,\n\nPlease find our quotation attached for your review.\n\nRegards"
    else:
        subject = f"Invoice {doc.number}"
        body = "Dear Sir/Madam,\n\nPlease find the attached invoice.\n\nRegards"
    return {
        "test_id": doc.test_id,
        "shape": "internal InboundEmail (adapter output), not a provider webhook",
        "provider_email_id": f"test-email-{doc.test_id}",
        "attachment_id": f"test-att-{doc.test_id}-1",
        "from": sender,
        "to": [INBOUND_ADDRESS],
        "subject": subject,
        "body_text": body,
        "is_reply_with_token": bool(token_of),
        "token_placeholder": f"{{{{TOKEN:{token_of}}}}}" if token_of else None,
        "token_note": ("Replace the placeholder with the token issued when the correction email for "
                       f"{token_of} was sent (format R-<id>).") if token_of else None,
        "attachments": [{"filename": doc.filename, "path": f"invoices/{doc.filename}", "content_type": "application/pdf"}],
    }


def main():
    for p in (OUT, PDF_DIR, EMAIL_DIR):
        p.mkdir(parents=True, exist_ok=True)
    for old in list(PDF_DIR.glob("*.pdf")) + list(EMAIL_DIR.glob("*.json")):
        old.unlink()

    # reference data
    write_csv(OUT / "vendors.csv",
              ["vendor_id", "legal_name", "aliases", "gstin", "pan", "bank_name", "ifsc", "bank_account",
               "bank_last4", "payment_terms_days", "registered_senders", "address", "phone"],
              [[vid, v["name"], "|".join(v["aliases"]), v["gstin"], v["pan"], v["bank_name"], v["ifsc"],
                v["bank_account"], v["bank_account"][-4:], v["terms"], "|".join(v["senders"]),
                ", ".join(v["address"]), v["phone"]] for vid, v in VENDORS.items()])
    write_csv(OUT / "catalog.csv", ["item_code", "description", "base_uom", "pack_uom", "pack_size"],
              [[c["item_code"], c["description"], c["base_uom"], c["pack_uom"], c["pack_size"]] for c in CATALOG])
    po_rows, line_rows = [], []
    for po, (vid, pdate, lines) in POS.items():
        sub = money(sum(D(str(q)) * D(p) for (_, _, _, _, _, q, p, _) in lines))
        po_rows.append([po, vid, pdate.isoformat(), "open", "pre-tax", str(sub)])
        for (no, code, kind, desc, uom, q, p, g) in lines:
            line_rows.append([po, no, code, kind, desc, uom, q, p, g, str(money(D(str(q)) * D(p)))])
    write_csv(OUT / "purchase_orders.csv",
              ["po_number", "vendor_id", "po_date", "status", "price_basis", "subtotal_pretax"], po_rows)
    write_csv(OUT / "po_lines.csv",
              ["po_number", "line_no", "item_code", "line_kind", "description", "uom", "qty_ordered",
               "unit_price_pretax", "gst_rate", "line_amount_pretax"], line_rows)
    (OUT / "settings.json").write_text(json.dumps(SETTINGS, indent=2), encoding="utf-8")

    # documents
    answer = {"version": "test-data v2.1 (spec v1.2.2, test matrix v1.2.2)",
              "note": "Expected outcomes are declared from the test matrix before any application run.",
              "tests": []}
    summary = []
    for doc in DOCS:
        figs = compute(doc)
        path = PDF_DIR / doc.filename
        if doc.layout == "SCAN":
            render_scan(doc, figs, path)
        else:
            render_pdf(doc, figs, path)
        plan = RUN_PLAN[doc.test_id]
        exp = EXPECTED[doc.test_id]
        email = email_payload(doc, plan)
        (EMAIL_DIR / f"{doc.test_id}.json").write_text(json.dumps(email, indent=2), encoding="utf-8")
        entry = {
            "test_id": doc.test_id,
            "file": f"invoices/{doc.filename}",
            "email_payload": f"emails/{doc.test_id}.json",
            "group": plan["group"],
            "order": plan["order"],
            "path": plan["path"],
            "sender": plan["sender"],
            "setup": plan.get("setup"),
            "after_run": plan.get("after"),
            "reply_token_of": plan.get("reply_token_of"),
            "has_text_layer_expected": doc.layout != "SCAN",
            "vendor_id": doc.vendor_id,
            "expected_extraction": expected_extraction(doc, figs),
            "computed_total": str(figs["computed_total"]),
            "ai_mapping_ground_truth": AI_MAPPING_GROUND_TRUTH.get(doc.test_id),
            "critical_fields": CRITICAL_FIELDS if exp.get("extraction_accuracy_required") else None,
            "expected": exp,
        }
        answer["tests"].append(entry)
        summary.append([doc.test_id, plan["group"], plan["order"], doc.filename, plan["path"], plan["sender"],
                        doc.vendor_id or "UNKNOWN", doc.number, doc.po_ref or "", str(figs["total"]),
                        exp["outcome"], "|".join(exp["blocking"]), "|".join(exp["info"]),
                        "|".join(exp["side_effects"]), plan.get("setup") or plan.get("after") or ""])
    (OUT / "answer_key.json").write_text(json.dumps(answer, indent=2), encoding="utf-8")
    write_csv(OUT / "expected_results.csv",
              ["test_id", "group", "order", "file", "path", "sender", "vendor_id", "invoice_number",
               "po_reference", "printed_total", "expected_outcome", "expected_blocking_codes",
               "expected_info_codes_min", "expected_side_effects", "setup_or_follow_up"], summary)
    print(f"Generated {len(DOCS)} documents in {PDF_DIR}")


if __name__ == "__main__":
    main()
