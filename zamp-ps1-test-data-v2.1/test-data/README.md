# PS-1 Test Data v2.1

Fictional test data for the invoice-processing workflow. It matches `claude/workflow-spec.md` v1.2.2 and `claude/test-matrix.md` v1.2.2.

v2.1 changes three files, `settings.json`, `answer_key.json` and the S7 PDF:
- **S12:** the lump-sum rule is clarified. Explicit markers are now in `settings.json`, and S12's note explains how it is detected.
- **S7:** the scan is re-rendered for legibility and is still image-only. Its answer-key entry now declares the inferred PO (PO-1004), the open POs considered, and the critical fields that must be extracted exactly.

The other 17 PDFs, the CSVs and the email payloads are byte-identical to v2.

Everything here is invented: companies, people, GSTINs, PANs, bank accounts, IFSC codes, addresses, phone numbers and email addresses. Each PDF carries the footer "FICTIONAL TEST DOCUMENT".

## Contents

| Path | What it is |
|---|---|
| `vendors.csv` | Trusted vendor master V01–V06: GSTIN, PAN, bank account and last 4, terms, registered senders. QuickServe is deliberately absent. |
| `catalog.csv` | Unit conversions: CONT-500 pack = 50 pcs; BAG-M bundle = 100 pcs. |
| `purchase_orders.csv`, `po_lines.csv` | 10 open POs. Prices are pre-tax; 18% GST except PO-7731 (no GST). No PO has a charge line. |
| `settings.json` | Tolerances (price ±2%, quantity 0, rounding Rs 1), approval limit Rs 2,00,000, AP-forwarder allowlist, charge keywords, **lump-sum markers**, buyer details. |
| `invoices/*.pdf` | 18 one-page documents: S1–S14 (with S6a/S6b) and X1–X3. |
| `emails/*.json` | One internal `InboundEmail` payload per test: from, to, subject, body, attachment, ids. This is the adapter output, not a provider webhook. |
| `answer_key.json` | For each test: ground-truth extraction, run order and setup, AI-mapping ground truth (S14), declared expected outcome, and for S7 the critical fields and the expected inferred PO. |
| `expected_results.csv` | The same expectations as one flat table. |
| `validation_report.txt` | Output of the last validator run. |
| `oracle_results.json` | What the independent rule oracle concluded for each test. |
| `../scripts/fonts/` | DejaVu Sans Condensed, used to render the scan, with its Bitstream Vera licence. Bundled so the scan renders the same on any machine. |

## Regenerate and validate

```
pip install reportlab pillow pdfplumber pypdf
python scripts/generate_test_data.py      # deterministic on the same machine and library versions
python scripts/validate_test_data.py      # exit 0 = no check failed
```

The S7 legibility sweep needs `tesseract` and `pdftoppm`. Without them those checks show as SKIP, never as PASS.

## How to run the tests

- **Scenario set (one database, in this order):** S1, S2, S3, then send the correction email for S3, then S4, S5, S6a, S6b, S7, S8, S9, S10, S11, S12, S13, S14.
- **X1, X2, X3 (fresh database each):** follow the `setup` field in `answer_key.json`.
- **Tokens:**
  - The S4 and X1 payloads contain `{{TOKEN:S3}}` in the subject and body.
  - Replace it with the token your app issued when it sent S3's correction email (format `R-<id>`).
  - X2 deliberately has no token.
- **Live email (E2E):**
  - The `.example` sender addresses cannot send real mail.
  - Before a live test, set the vendor's registered sender in your seeded master to the address you will send from.
  - For S8, send from an address that is *not* registered.
- **Pass rule (matrix):** all of the following must hold:
  - the outcome matches;
  - the blocking codes match exactly;
  - every expected info code is present (extra info codes are allowed);
  - every expected side effect is observed.
- **S7 must also pass:**
  - the inferred PO must be PO-1004;
  - every field in `critical_fields` must equal `expected_extraction`. Amounts, quantities and rates compare numerically; identifiers compare ignoring spaces and case; descriptions compare on normalised words; `po_reference` must be empty.

## Assumptions and design choices

- **Lump-sum lines (M5):**
  - A line is lump-sum only when it carries an explicit marker: the phrase "lump sum" or "lumpsum" (any case; "Lump-Sum" counts) in its description or unit, or the unit code `LS`.
  - Detection runs before normal line matching.
  - A PO number in the description is not a marker. Neither is the catalog pack word "bundle".
- **Units:**
  - Invoice units are printed exactly as on the PO ("bottle", "pack"). The spec defines no unit-alias table.
  - Unit conversion happens only through the catalog.
- **GSTINs:**
  - Every vendor GSTIN is well-formed and embeds that vendor's PAN.
  - Every vendor GSTIN fails the GSTIN check-digit test (verified by the validator), so none of them can be a real registration.
- **Phone numbers:** they use subscriber numbers starting with 0, which no real line has.
- **Email addresses:** they use the reserved `.example` domain.
- **Bank details:** bank codes are `EXMP` and bank names say "Example".
- **Bank details on each invoice:** every V01–V06 invoice prints the master bank account, except S2, which prints an account ending in 0091 where the master says 2290.
- **S9 (quotation):** the word "invoice" appears nowhere in its text layer.
- **S7 (scan):**
  - It is an image-only PDF at 200 dpi, with no text layer and no fonts.
  - It is greyscale with a 0.9° tilt, mild blur, grain and a scanner shadow.
  - The outcome-critical fields are set at 38–48 px (about 14–17 pt): vendor, GSTIN, number, date, line rows, totals and bank account. GSTIN, invoice number and account number are bold.
  - Secondary text is smaller.
- **Dates:** invoice dates are 10–20 Oct 2026. The V5 future-date check uses 22 Oct 2026 as "today".
- **S5 (reprint):** it prints "Duplicate copy for your records", as reprints commonly do. D1 does not depend on that wording.

## Limitations and remaining uncertainty

- **What the validator proves:**
  - The rule oracle uses the ground-truth extraction, so it validates the data and the expected outcomes.
  - It does not validate the application or the AI.
  - No application test has been executed.
- **S7 legibility is measured with tesseract, not with Gemini:**
  - Every critical field reads correctly in all 12 tesseract configurations (100, 150, 200 and 300 dpi × page-segmentation modes 3, 4 and 6).
  - Row integrity is judged in the 8 row-preserving configurations.
  - That is evidence of legibility, not proof that Gemini will extract the page correctly. That is unverified until the app's first S7 run.
- **Misreads tesseract made during tuning, before the final rendering:**
  - "Q" read as "0" in the GSTIN.
  - "pcs" read as "pes".
  - Words merging at 100 dpi.
  - Table rows splitting when the tilt was 1.2° or more.

  These are the errors to look for in the app's S7 extraction.
- **S7 misreads fail the test, not pass it quietly.** The validator proves the S7 test rejects six realistic misreads:
  - GSTIN, unit, line amount, a bank digit and an invented PO reference all add a blocking code.
  - A date misread adds no code but fails the field check.
  - The outcome is always ON_HOLD (V4), so a misread scan can never clear.
- **Lump-sum lines without a marker go through normal matching:**
  - Such a line is held under whatever codes the matching produces (S12's wording without a marker ends PRICE_OVER_TOLERANCE).
  - Residual risk: if the line's words cover one PO line and its price and quantity match that line, it clears against that line.
  - The marker list is in `settings.json`.
- **S14 needs the AI mapping proposal:**
  - S14 needs the AI mapping proposal (M2).
  - If M2 is cut, change S14's expectation to ON_HOLD LINE_UNMAPPED before running (matrix footnote *).
- **Determinism:** output is byte-identical across runs on the same machine. Other FreeType or Pillow versions may change the scan's pixels, but not its layout or content.
- **Volume set:** the 50-invoice volume set is not generated (separate approval).
