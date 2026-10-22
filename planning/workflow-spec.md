# PS-1 Workflow Specification v1.4
Status: v1.4, 23 Oct 2026: rule changes from the product audit, decided by the owner and listed in section 18 (implemented ones are applied in place). v1.3 design frozen, 22 Oct 2026. v1.3 resolves the read-only pre-build audit (22 Oct): decisions A1-A14 (section 17) are applied in place, and section 16 makes normalisation and rule order binding. v1.2.2 clarified M5 (lump-sum markers). v1.2.1 added decision U1 (demo identity). Nothing implemented or tested.
Changes from v1.1: correction linking requires a reply carrying our reference token; human approval (individual or batch, audited) required before export; disputes block export; approved invoices never silently replaced; charges detected by keyword rules plus deterministic PO comparison; chain invariant; distinct Cleared / Approved / Exported / Paid semantics. v1.2.1: reviewer identity is a self-selected display name, labelled "Demo identity — not authentication".
Related (repository folder planning/): test-matrix.md v1.3, implementation-plan.md v2.4, SOLUTION_REVIEW.md. Test data: zamp-ps1-test-data-v2.1/.

## 1. Principles
- P1. AI extracts and proposes. Deterministic code validates and decides. Humans resolve holds and approve for export.
- P2. Never clear automatically when: a required field is missing; the PO is not found or ambiguous; any line is unmapped; any charge is unapproved; any required validation fails; vendor, sender or bank details are unverified; the document has no usable text layer. The sender condition applies to email intake; an upload is an internal action by a reviewer and has no external sender (K3, A1).
- P3. Every hold carries at least one reason code plus evidence (expected, actual, source).
- P4. Unsupported situations are held, never presented as resolved. Every check in sections 4-8 (V5, D4 and C5 included) is part of the rule engine and is built before any scenario result is recorded; no check is deferred to a later phase (A2). Anything else the product cannot handle is held, never silently passed.
- P5. System failures end in FAILED (retryable), never in a business decision.
- P6. Every fact shown comes from stored data; AI text cannot introduce unverified amounts or identifiers.
- P7. AI outputs are proposals; none changes state or money.
- P8. The product never claims payment or payment authorisation (section 12).
- P9. Chain invariant: for one vendor and one normalised invoice number, at most one run can be CLEARED or APPROVED at any time.
- P9b (v1.4). The invariant also holds when no chain could be built (vendor unknown, reading failed): an approval by override, link confirmation or replacement is refused when another CLEARED or APPROVED run has the same file (sha256), or the same normalised invoice number from the same vendor (master id, else the normalised printed name). Refusal reason: POSSIBLE_DOUBLE_BILLING. An override is never offered for CREDIT_NOTE_UNSUPPORTED (G3) or for a run whose total was never read.
- P10. The product never presents the reviewer's display name as a verified identity and provides no production-grade access control (section 12).

## 2. Logical data model
- vendors (trusted master, seeded; not editable in the product): id, legal_name, aliases[], gstin (nullable), pan, bank_last4, payment_terms_days, registered sender emails.
- catalog_items: item_code, base_uom, pack_uom, pack_size (only source of conversions).
- purchase_orders, po_lines: line_kind (goods / service / charge), description, uom, qty_ordered, unit_price_pretax, gst_rate.
- documents: source (email / upload), provider_email_id, attachment_id, sender_email (email only), uploader_display_name (upload only; demo identity), subject, body_text, reply_ref_token (parsed), sha256, has_text_layer (>= 50 extracted characters; images false).
- runs: state, version, outcome_codes[], info_codes[], primary_reason, vendor_id, po_number, po_match_method, invoice_number_norm, chain_key, invoice_date, amounts, supersedes_run_id, superseded_by_run_id, export_blocked, export_block_reason, due_date, cleared_at.
- approvals: run_id, approver_display_name (self-selected demo identity, unverified), approved_at, mode (individual / batch / override / link-confirmation / replacement), batch_id, note.
- exports: export_id, created_by_display_name, created_at, run_ids[]. A run's exported_at and export_id are set here.
- correction_requests: run_id, token, sent_at, channel (sent / marked sent manually).
- extractions, line_results, events (audit; user actions record the display name), reviews, outbound_messages.
- Money (A3): amounts (line amounts, subtotals, tax, totals, consumption) in integer paise. Unit prices (up to 4 decimal places) and quantities (up to 3) are exact decimals; binary floating point is never used for money. Line amount = quantity x unit price, rounded half-up to the paisa. The Rs 1 tolerance applies to V2 arithmetic only; every other comparison is exact (C1 by cross-multiplication, section 16.4). PO consumption counts CLEARED and APPROVED runs, stored per PO line as base quantity and pre-tax paise.

## 3. Pipeline stages
| # | Stage | Done by | Failure handling |
|---|---|---|---|
| 0 | Intake (email webhook or upload) | code | Idempotency (section 11). Supported: PDF, PNG, JPEG up to 4 MB; each supported attachment is its own run (A12). No attachment: SKIPPED NO_ATTACHMENT. Unsupported type or > 4 MB: SKIPPED UNSUPPORTED_FILE. Attachment fetch: 3 attempts, then FAILED ATTACHMENT_FETCH_FAILED. Reply token parsed from subject or body |
| 1 | Read and classify (one AI call) | AI + schema check | Transport errors: 3 attempts, then FAILED PROCESSING_ERROR. Schema-invalid: 2 attempts, then hold EXTRACTION_FAILED. Cached by sha256 + prompt_version + model |
| 2 | Classification guard | code | G1-G3 |
| 3 | Document validation | code | V1-V5 |
| 4 | Vendor, sender, bank | code | K1-K4 |
| 5 | Duplicates and corrections | code | D1-D4, token rule |
| 6 | PO match | code | P1-P2 |
| 7 | Lines, charges, tax basis | code; AI proposal only as mapping fallback | M1-M7, T1-T4; per-line order in section 16.2 |
| 8 | Compare to PO | code | C1-C5 |
| 9 | Decide and link | code | Section 9; supersession and dispute effects applied atomically; stages 8-9 run in one transaction holding locks on the run's PO and chain (section 11, A11) |
Checks that need a missing earlier result are recorded "not evaluated (reason)".

## 4. Checks (no confidence thresholds)
- G1. doc_type quotation / statement / other with no invoice title or number label: SKIPPED NOT_INVOICE.
- G2. doc_type not invoice but title contains "invoice" / "tax invoice" / "bill of supply" or number label says "invoice": CLASSIFICATION_CONFLICT.
- G1b (v1.4). doc_type invoice, but the read title or number label contains quotation, quote, estimate, proforma (pro forma, pro-forma), challan or statement; or the document's text layer contains proforma; or it contains quotation, estimate or delivery challan and neither "tax invoice" nor "bill of supply": CLASSIFICATION_CONFLICT (evidence: the word and where it was found). Whole words only. The finding is recorded and the run continues, as for G2.
- G3. Credit note: CREDIT_NOTE_UNSUPPORTED.
- V1. Required: invoice number, date, vendor identity, at least one line, total: else MISSING_REQUIRED_FIELD.
- V2. Arithmetic within Rs 1 on the extracted price basis (section 16.4: lines, subtotal or taxable value, tax components, tax per line rate, total): else ARITHMETIC_MISMATCH, or TAX_BASIS_UNCLEAR when only another basis is consistent (T3).
- V3. Text-layer documents: invoice number, total, PO reference (if extracted), every line amount and unit price, and the bank account last 4 (if extracted) must appear in the normalised text: else EVIDENCE_NOT_FOUND (A14).
- V3b (v1.4). The total, line amounts and unit prices must each appear as a whole printed number of the same value (digit grouping and trailing zeros ignored: "13,000" vouches for 13000.00), not as digits inside a longer number; else EVIDENCE_NOT_FOUND. Invoice number, PO reference and bank last 4 keep the normalised-text check.
- V4. No usable text layer: SCAN_UNVERIFIED, always, even if every other check passes.
- V5. Date more than 1 day in the future: DATE_INVALID (P2).
- K1. GSTIN exact, else normalised name or alias: else VENDOR_UNKNOWN.
- K2. Name matches, GSTIN differs: VENDOR_GSTIN_MISMATCH.
- K3. Email: sender registered for the vendor or on the AP-forwarder allowlist: else SENDER_UNVERIFIED. Upload: an internal action by a reviewer; recorded "not evaluated: internal upload by <display name> (demo identity)" (A1). K1, K2 and K4 still apply to uploads.
- K4. Printed bank account last 4 digits vs trusted master: different: BANK_DETAILS_CHANGED (evidence: both values; "verify by phone using the vendor master number"). Not printed: info BANK_NOT_SHOWN.
- K4b (v1.4). No bank account was read, but the text layer shows bank wording ("A/c", "Account No", "Account Number" or "IFSC"): MISSING_REQUIRED_FIELD (evidence: field "bank account", the wording, the master's last 4). An account the reader left out is a misread, not an absence; this closes the gap between P2 ("never clear when bank details are unverified") and K4.

## 5. Duplicates and corrections
Normalised number: split on non-alphanumerics, uppercase, strip leading zeros from numeric tokens, join. Chain = same vendor + normalised number.
- D1. Exact duplicate: same chain + same date + same total (exact to the paisa) as an earlier run in any state except FAILED or SKIPPED: REJECTED DUPLICATE_INVOICE.
- Precedence after D1 (A7): if the chain has a CLEARED or APPROVED run, D3 applies; otherwise, if it has an ON_HOLD or AWAITING_VENDOR run, D2 applies; otherwise, if it has a REJECTED run, D3 applies (hold only). A payable run in the chain always takes precedence because that is where double payment happens.
- D2. Correction candidate: same chain, different total or lines, earlier run in ON_HOLD or AWAITING_VENDOR.
  - Explicit link exists only when the email is a reply carrying our token "[Ref R-<id>]" (subject or body) that points to a run in the same chain, and the sender is registered for that vendor. A revision marker ("Revised", "Corrected") is recorded as evidence but is never sufficient. Uploads cannot carry a token.
  - Linked and every check passes: candidate CLEARED with CORRECTION_OF; all hold-family runs in the chain become SUPERSEDED in the same transaction (transition 15).
  - Linked but a check fails: candidate ON_HOLD with its failure codes and info CORRECTION_CANDIDATE_OF. Nothing is superseded, by any path. If the candidate is later approved by override (transition 9), the original stays on hold until a reviewer rejects it separately.
  - Not linked: candidate ON_HOLD CORRECTION_UNCONFIRMED (plus any failure codes). A reviewer may confirm the link only if CORRECTION_UNCONFIRMED is its sole blocking code (transition 16).
  - In every hold case an earlier run in AWAITING_VENDOR returns to ON_HOLD (transition 12).
- D3. Possible double billing: same chain, different content, earlier run CLEARED, APPROVED or REJECTED. New run ON_HOLD POSSIBLE_DOUBLE_BILLING, plus:
  - earlier CLEARED: earlier run -> ON_HOLD RELATED_INVOICE_DISPUTE (transition 8); consumption released; not exportable.
  - earlier APPROVED, not exported: earlier run stays APPROVED with export_blocked = RELATED_INVOICE_DISPUTE until the dispute is resolved (new run rejected, or explicit replacement via transition 17). Never silently replaced.
  - earlier APPROVED and exported: earlier run unchanged; approving the new run is blocked (requires the company's credit-note process, out of scope); reviewer can only reject or keep it on hold.
  - earlier REJECTED: hold only.
  - Consumption (A8): when the counterpart is CLEARED, or APPROVED and not exported, stage 8 evaluates the new run's C2/C3 excluding the counterpart's consumption (the new run is assessed as its possible replacement, which makes row 17 reachable). An exported counterpart's consumption is never excluded. The counterpart's effects (row 8, or the export block) are applied in stage 9 in the same transaction.
  - Resolution (A8): rejecting the new run (row 10) lifts an APPROVED counterpart's export block in the same transaction. A counterpart moved to ON_HOLD RELATED_INVOICE_DISPUTE is resolved like any hold: approve by override (row 9, note) or reject (row 10).
- D4. Different number, same vendor, date and total: POSSIBLE_DUPLICATE (P2).

## 6. PO match
- P1. Extracted reference normalised within the vendor's POs ("7731" = "PO-7731"); else PO_NOT_FOUND / PO_VENDOR_MISMATCH / PO_CLOSED.
- P2. No reference: one open PO: PO_INFERRED; several: keep those on which every invoice line maps by M1 (deterministic only; AI proposals are never used for inference, A6); one left: PO_INFERRED; else PO_AMBIGUOUS; none: PO_NOT_FOUND. Never guess.

## 7. Lines, charges, tax basis
- M1. Deterministic mapping: item code; or all significant normalised PO-description tokens present in the invoice line, with exactly one PO line satisfying this.
- M2. AI proposal (fallback, P1) for lines M1 cannot map; proposal only.
- M3. Code verifies every mapping: compatible units via catalog; printed pack size equals catalog; base quantity and price computed by code. Failure: AI_PROPOSAL_REJECTED (blocking) together with LINE_UNMAPPED or UOM_UNSUPPORTED (A5).
- M3b (v1.4). An AI proposal is also accepted only with support the code can check on the invoice line: the PO line's item code is printed, or the catalog pack conversion is backed by a printed pack size that the AI read the same way, or the invoice and PO (or catalog) descriptions share an item word (not a number or unit word). A size printed on both lines that disagrees (750 ml against 500 ml; cc counts as ml, l as 1000 ml, kg as 1000 g) rejects the proposal in every case. Failure: AI_PROPOSAL_REJECTED with LINE_UNMAPPED.
- M4. One PO line per invoice line and vice versa per invoice. A second invoice line mapping to an already-matched PO line: LINE_UNMAPPED, with evidence naming the earlier line (A5).
- M5. Lump-sum (bundled) lines. Runs before M1-M4 for every line.
  - Detection uses explicit markers only: the phrase "lump sum" or "lumpsum" in the line's description or unit (case-insensitive, matched on normalised words, so "Lump-Sum" counts), or the unit code LS. The marker list is a setting.
  - A PO number in the description is not a marker, and neither is the catalog pack word "bundle". Lines without a marker go through M1-M4 like any other line.
  - A detected line is not mapped and is excluded from C1-C3. Pre-tax amount <= PO remaining (PO subtotal minus consumed): BUNDLED_QUANTITY_UNVERIFIED; higher: PO_AMOUNT_EXCEEDED. Always held.
- M6. Unsupported (conversions not in catalog, mixed rates, many-to-one, discounts): UOM_UNSUPPORTED or LINE_UNMAPPED.
- M7. Charges (deterministic):
  - Detection: line description matches a charge keyword (whole word or phrase, case-insensitive): delivery, freight, transport, transportation, handling, packing, loading, unloading, cartage, courier, shipping, surcharge, "service charge", "convenience fee".
  - Comparison: a keyword line is accepted only if the PO has a charge line sharing the keyword and the invoiced amount is <= that PO amount x 1.02 (including amounts already consumed). Otherwise UNAPPROVED_CHARGE.
  - Supporting signals (amount with no quantity or unit; AI line_type = charge) are recorded as evidence only. They never classify a line by themselves; a non-keyword line that does not map ends LINE_UNMAPPED (evidence notes "possible charge").
- T1. Exclusive basis: compare with PO pre-tax price. T2. Inclusive (stated, one rate per line): pre-tax = inclusive / (1 + rate). T3. Basis consistency (section 16.4, A9): the stated basis fails V2 but another basis passes, or tax is shown with no stated basis: TAX_BASIS_UNCLEAR. T4. Line rate vs PO rate: TAX_RATE_MISMATCH.

## 8. Compare to PO (mapped goods and service lines only)
- C1. Price > PO x 1.02: PRICE_OVER_TOLERANCE; < PO x 0.98: info PRICE_BELOW_PO; else info PRICE_WITHIN_TOLERANCE.
- C2. Quantity + consumed > ordered: QTY_EXCEEDS_PO.
- C3. Mapped amounts + consumed > PO subtotal x 1.02: PO_AMOUNT_EXCEEDED (equal allowed). Charge and unmapped lines excluded (they hold under their own codes).
- C4. Consumption counts CLEARED and APPROVED; override approvals re-run C2/C3.
- C4b (v1.4). A held line on a known PO (unmapped, unit unverified, AI proposal rejected, unapproved charge, duplicate mapping) records its pre-tax amount at PO level (line 0), as a lump-sum line does; it counts only once the run is approved. When no PO was found for a known vendor, the override names one of the vendor's open POs; lines that map by M1 then count per PO line, the rest at PO level, and C2/C3 re-run against it.
- C5. Total > Rs 2,00,000: APPROVAL_LIMIT_EXCEEDED (P2).
Settings (shown in UI): tolerances, rounding, approval limit, allowlist, catalog, charge keywords, lump-sum markers.

## 9. Decision rules
1. FAILED: system error. 2. SKIPPED: NO_ATTACHMENT, UNSUPPORTED_FILE, NOT_INVOICE. 3. REJECTED: DUPLICATE_INVOICE. 4. ON_HOLD: any hold code. 5. CLEARED: no hold code, text layer present, chain invariant satisfied (if clearing would violate P9, the run is held POSSIBLE_DOUBLE_BILLING, A5); due date = invoice date + terms; consumption counted.
Severity: MANUAL_HOLD, VENDOR_UNKNOWN, VENDOR_GSTIN_MISMATCH, SENDER_UNVERIFIED, BANK_DETAILS_CHANGED, POSSIBLE_DOUBLE_BILLING, RELATED_INVOICE_DISPUTE, POSSIBLE_DUPLICATE, CORRECTION_UNCONFIRMED, CLASSIFICATION_CONFLICT, CREDIT_NOTE_UNSUPPORTED, EXTRACTION_FAILED, MISSING_REQUIRED_FIELD, EVIDENCE_NOT_FOUND, ARITHMETIC_MISMATCH, SCAN_UNVERIFIED, TAX_BASIS_UNCLEAR, PO_NOT_FOUND, PO_VENDOR_MISMATCH, PO_CLOSED, PO_AMBIGUOUS, UNAPPROVED_CHARGE, LINE_UNMAPPED, UOM_UNSUPPORTED, AI_PROPOSAL_REJECTED, TAX_RATE_MISMATCH, QTY_EXCEEDS_PO, PO_AMOUNT_EXCEEDED, PRICE_OVER_TOLERANCE, BUNDLED_QUANTITY_UNVERIFIED, DATE_INVALID, APPROVAL_LIMIT_EXCEEDED.

## 10. Reason codes
| Code(s) | Outcome | Evidence | Priority |
|---|---|---|---|
| NO_ATTACHMENT, UNSUPPORTED_FILE, NOT_INVOICE | Skipped | Sender, file, doc type, title | P0 |
| DUPLICATE_INVOICE | Rejected | Earlier run, normalised numbers | P0 |
| VENDOR_UNKNOWN, SENDER_UNVERIFIED, BANK_DETAILS_CHANGED | Hold | Name/GSTIN; sender; both bank last-4s | P0 |
| VENDOR_GSTIN_MISMATCH | Hold | Both GSTINs | P1 |
| POSSIBLE_DOUBLE_BILLING, RELATED_INVOICE_DISPUTE, CORRECTION_UNCONFIRMED | Hold | Both runs; token status | P0 |
| POSSIBLE_DUPLICATE | Hold | Both runs | P2 |
| CLASSIFICATION_CONFLICT, EXTRACTION_FAILED, MISSING_REQUIRED_FIELD, EVIDENCE_NOT_FOUND, ARITHMETIC_MISMATCH, SCAN_UNVERIFIED | Hold | Title; schema errors; fields; values searched; calculations; image beside values | P0 |
| CREDIT_NOTE_UNSUPPORTED | Hold | Title | P1 |
| TAX_BASIS_UNCLEAR | Hold | Both calculations | P0 |
| TAX_RATE_MISMATCH | Hold | Rates | P1 |
| PO_NOT_FOUND, PO_AMBIGUOUS | Hold | Reference; candidates | P0 |
| PO_VENDOR_MISMATCH, PO_CLOSED | Hold | Owner; status | P1 |
| UNAPPROVED_CHARGE, LINE_UNMAPPED, UOM_UNSUPPORTED, AI_PROPOSAL_REJECTED | Hold | Line, keyword, PO charge lines, AI proposal and why code rejected it | P0 |
| QTY_EXCEEDS_PO, PO_AMOUNT_EXCEEDED, PRICE_OVER_TOLERANCE, BUNDLED_QUANTITY_UNVERIFIED | Hold | Ordered, consumed, invoiced, % | P0 |
| DATE_INVALID, APPROVAL_LIMIT_EXCEEDED | Hold | Date; limit | P2 |
| MANUAL_HOLD | Hold | Reviewer note, display name, time | P0 |
| ATTACHMENT_FETCH_FAILED, PROCESSING_ERROR | Failed | Error, attempts | P0 |
Info: PO_INFERRED, PRICE_WITHIN_TOLERANCE, PRICE_BELOW_PO, BANK_NOT_SHOWN, LINE_MAPPED_AI_VERIFIED, CORRECTION_OF, CORRECTION_CANDIDATE_OF.

## 11. States, transitions, retries, idempotency
States: RECEIVED, PROCESSING, SKIPPED, CLEARED, ON_HOLD, AWAITING_VENDOR, APPROVED, REJECTED, SUPERSEDED, FAILED.
| # | From | To | Trigger | Actor | Note | Guards |
|---|---|---|---|---|---|---|
| 1 | RECEIVED | PROCESSING | start | system | no | |
| 2 | PROCESSING | SKIPPED / CLEARED / ON_HOLD / REJECTED | decision | system | no | section 9; P9 |
| 3 | PROCESSING | FAILED | error after retries | system | no | |
| 4 | FAILED | PROCESSING | retry, same run id | user | no | logged |
| 5 | SKIPPED | PROCESSING | process as invoice | user | yes | G1 bypassed for this run and recorded; every other check runs (A10); refused when no file is stored |
| 6 | CLEARED | APPROVED | approve, individual or batch | user | no | display name and time recorded; not export-blocked; P9 |
| 7 | CLEARED | ON_HOLD | manual hold | user | yes | code MANUAL_HOLD (A5) |
| 8 | CLEARED | ON_HOLD | RELATED_INVOICE_DISPUTE (D3) | system | no | consumption released |
| 9 | ON_HOLD | APPROVED | override | user | yes | C2/C3 re-run (second confirmation if failing); P9 and P9b; C4b (PO named when none was found); a hold on the vendor, its GSTIN, the sender or the bank account needs a callback record (number called, person, time; the vendor-master number when the vendor is known) and a second confirmation (v1.4, Q9); blocked if the counterpart in D3 is exported; never supersedes |
| 10 | ON_HOLD | REJECTED | reject | user | yes | |
| 11 | ON_HOLD | AWAITING_VENDOR | correction email sent or marked sent manually; only when a hold is one the vendor can fix (v1.4, section 18) | user | no | token issued and logged |
| 12 | AWAITING_VENDOR | ON_HOLD | vendor reply held (D2) | system | no | |
| 13 | AWAITING_VENDOR | ON_HOLD | stop waiting | user | yes | |
| 14 | AWAITING_VENDOR | APPROVED / REJECTED | reviewer decision | user | yes | as row 9 for APPROVED |
| 15 | ON_HOLD / AWAITING_VENDOR | SUPERSEDED | token-linked correction cleared | system | no | correction passed every check; same transaction |
| 16 | ON_HOLD / AWAITING_VENDOR | SUPERSEDED | reviewer confirms link | user | yes | candidate's only blocking code is CORRECTION_UNCONFIRMED; candidate -> APPROVED in the same transaction |
| 17 | APPROVED (not exported) | SUPERSEDED | reviewer replaces the approved invoice | user | yes | candidate's only blocking code is POSSIBLE_DOUBLE_BILLING; candidate -> APPROVED in the same transaction |
Terminal: REJECTED, SUPERSEDED, and APPROVED once exported. Before export, APPROVED leaves only through row 17. Every other transition is refused and logged INVALID_TRANSITION_BLOCKED; so is any user action that would violate P9 (reason CHAIN_INVARIANT, A5). Failed corrections can never supersede: rows 15-17 require the candidate to have passed every check except the single linking code.
Export (event, not state): only APPROVED, not exported, not export-blocked runs; records export_id, display name and time; emits EXPORTED. Re-export is impossible.
Retries: AI transport 3 attempts; schema-invalid 2 attempts; attachment fetch 3 attempts. FAILED retry reuses run id and cache; state change, consumption, links and audit are one transaction.
Idempotency: email key (provider_email_id, attachment_id): repeats logged DELIVERY_REPEAT_IGNORED. The same PDF in a new email is a new run (D1). Upload: same sha256 within 60 seconds returns the existing run. User actions carry the run version; repeats logged ACTION_REPEAT_IGNORED. Outbound messages send at most once per draft. A token stays valid for its run while the run is ON_HOLD or AWAITING_VENDOR; re-sending a correction issues a new token and earlier tokens for the same run stay valid (A12).
Concurrency (A11): stages 8-9 run in one transaction that takes transaction-scoped locks on the run's PO and chain before reading consumption, so concurrent runs on one PO or chain are serialised. Atomicity on the production database is proven by test T16, not assumed.

## 12. Status semantics and reviewer identity
| Status / event | Meaning | UI wording |
|---|---|---|
| CLEARED (state) | Every automated check passed; a recommendation | "Cleared by checks" |
| APPROVED (state) | A reviewer, identified by a self-selected display name, approved it for the payment list (individual, batch, override, link confirmation or replacement), with time | "Approved for payment list by <display name>, <time>" |
| EXPORTED (event) | Included in an export file handed to finance | "Exported to payment list <export id>" |
| Paid | Not tracked; payment authorisation and execution happen in the company's finance process | Never shown |
The product never displays "Paid", "Payment authorised" or "Final approval". Due date is labelled "Due (per terms)".
Reviewer identity (decision U1): the reviewer selects a display name before acting; every place the name is chosen or shown carries the label "Demo identity — not authentication". The selected name and timestamp are recorded on each approval, export and user action. The name is never described as verified, and the product provides no production-grade access control.

## 13. Human actions and outbound messages
Drafts: facts brief built by code; AI phrases it; Send enabled only when every amount and identifier exists in the brief. Correction emails put the token "[Ref R-<id>]" in the subject and body. Send failure: retry, or copy text and "mark sent manually" (labelled; token still issued). Assistant (P2): plain-English draft edits with the same fact check. Queue questions are dashboard filters.

## 14. AI usage contract
Gemini Flash (free tier) behind an extractor interface; versioned prompts; schema validation; caching. One read call per invoice; one mapping call only when M1 fails; drafts on demand. AI never computes decision totals, decides, links corrections, sends or changes state. Extraction schema: the shape of answer_key.json expected_extraction plus buyer_gstin; vendor and buyer identity are separate fields. A vendor_gstin equal to the buyer's own GSTIN (settings) is schema-invalid and retried as such: 2 attempts, then EXTRACTION_FAILED (A14). Free-tier content may be used by Google and read by reviewers: fictional data only.

## 15. Limitations (fail-safe behaviour)
- Text-layer evidence only; scans always held for confirmation.
- Vendors that reuse invoice numbers across financial years: held as duplicate or double billing (safe; human resolves).
- Disputes against exported invoices need a credit-note process (out of scope): the new invoice can only be held or rejected.
- Replies that drop the token: CORRECTION_UNCONFIRMED; a reviewer confirms.
- Charge wording outside the keyword list (for example "carriage", "frt."): ends LINE_UNMAPPED (still held).
- INR only; GST checked for consistency, not tax law; conversions only via the catalog; lump-sum lines always held; credit notes and discounts not processed.
- Lump-sum lines are recognised only by explicit markers. A multi-service line without one is matched like any other line and is normally held (wrong unit or price, or unmapped); if its words cover one PO line and its price and quantity match that line, it clears against that line.
- Reviewer identity is a self-selected demo display name, recorded but unverified; no authentication or access control.
- Uploads are trusted as internal actions (no sender check, A1). In this demo anyone with the link can upload and approve (P10); production would require authenticated staff.
- V3 is a presence check on normalised text: it catches values the document does not contain, not a misread that happens to match another value printed on the page.
- Synthetic data: accuracy describes our test set only.

## 16. Normalisation and rule order (binding; A4)
16.1 Normalisers
- Invoice number: section 5. PO reference: invoice-number normalisation, then a leading "PO" removed ("PO-7731" = "7731").
- Tokens: lowercase, split on non-alphanumeric characters. Significant tokens exclude: a, an, the, of, and, for, with, per, as, to, in.
- Units: lowercase and trimmed; a trailing "s" is dropped when the unit is longer than 3 characters, except "pcs". No other aliases; conversions only via the catalog.
- Normalised text (V3, K1 names): lowercase letters and digits only.
- Lump-sum markers and charge keywords match whole normalised words or phrases (M5, M7).

16.2 Per-line order in stage 7
1. M7: a charge keyword makes the line a charge line; it is never mapped.
2. M5: a lump-sum marker makes the line a lump-sum line; it is never mapped.
3. M1 deterministic mapping; then M2 proposal and M3 verification for lines M1 cannot map.
4. M4 one-to-one; T4 rate check.
5. C1-C3 on mapped lines only.

16.3 Not evaluated
- Vendor unknown: stages 5-8 and K4 are not evaluated, each recorded with the reason.
- SKIPPED at G1: nothing after stage 2 runs.

16.4 Arithmetic, basis and tolerance (A3, A9)
- Price basis comes from the extraction (exclusive / inclusive / none), read from explicit document wording; code never infers it from amounts.
- exclusive: each line amount = qty x unit price; sum of lines = subtotal; sum of (line amount x GST rate) = tax; CGST + SGST (or IGST) = tax; subtotal + tax = total.
- inclusive (one GST rate across lines, else TAX_BASIS_UNCLEAR): each line amount = qty x unit price; sum of lines = total; total / (1 + rate) = taxable value; taxable value + tax = total.
- none: each line amount = qty x unit price; sum of lines = subtotal = total; tax = 0.
- Each comparison within Rs 1. Stated basis consistent: pass. Stated basis inconsistent but another basis consistent: TAX_BASIS_UNCLEAR. No basis consistent: ARITHMETIC_MISMATCH. Tax shown but no basis stated: TAX_BASIS_UNCLEAR.
- C1 uses the pre-tax unit price (exclusive: unit price; inclusive: unit price / (1 + rate)) without rounding, by cross-multiplication: over tolerance when price x 100 > PO price x 102 (inclusive: price x 100 > PO price x 102 x (1 + rate)); below PO when price x 100 < PO price x 98 (same scaling); otherwise within tolerance.

16.5 Executable reference
- zamp-ps1-test-data-v2.1/scripts/validate_test_data.py implements stages 2-9 for the 18 scenarios; oracle_results.json holds its results. The spec wins on any difference, and differences are reported, never silently resolved.
- Known differences, all outside the 18 scenarios and covered by application tests instead: the oracle does not model D3 effects, approvals, export or rows 16-17; it applies V3 to number, total and PO only; it does not model T3 or the accepted-charge amount check; it evaluates D2 before D3.

## 17. Pre-build audit decisions (22 Oct 2026)
| # | Audit item | Decision | Applied in |
|---|---|---|---|
| A1 | Upload trust vs P2 | Uploads are internal reviewer actions: K3 not evaluated (recorded with the uploader's demo name); K1, K2, K4 still apply; limitation stated | P2, section 2, K3, section 15 |
| A2 | P4 during phased build | Every check in sections 4-8 is built in the rule engine before any scenario is recorded; nothing is deferred | P4; plan Phase C |
| A3 | Money precision | Paise for amounts; exact decimals for unit prices and quantities; half-up line rounding; Rs 1 for V2 only; C1 exact | Section 2, 16.4 |
| A4 | Oracle's implicit choices | Adopted as binding: normalisers, stopwords, plural units, per-line order, not-evaluated rules | Section 16 |
| A5 | Undefined codes | MANUAL_HOLD (row 7); P9 at decision: POSSIBLE_DOUBLE_BILLING; P9 on a user action: refused, CHAIN_INVARIANT; M4: LINE_UNMAPPED; AI_PROPOSAL_REJECTED is blocking with its partner code | M3, M4, sections 9-11 |
| A6 | P2 inference basis | M1 only; P2 is part of the rule engine (the Thursday milestone includes it) | P2 |
| A7 | D1 tolerance; D2 vs D3 | D1 exact to the paisa; a CLEARED or APPROVED run in the chain makes D3 take precedence | Section 5 |
| A8 | Row 17 feasibility; dispute resolution | New run's C2/C3 exclude an unexported counterpart's consumption; rejecting the new run lifts the export block; held counterpart resolved by row 9 or 10 | D3 |
| A9 | V2 inclusive; T3 trigger; basis source | Basis from extraction only; formulas and TAX_BASIS_UNCLEAR trigger fixed | V2, T3, 16.4 |
| A10 | Row 5 scope | Bypasses G1 only | Section 11 |
| A11 | Concurrency and atomicity | PO and chain locks in the stage 8-9 transaction; proven by T16 | Section 3, 11 |
| A12 | Intake details | PDF, PNG, JPEG up to 4 MB; one run per attachment; token validity rule | Section 3, 11 |
| A13 | Test execution, paths, databases | Golden run (recorded payloads + mock extractor) and live-extraction run; adapter always built; test and demo databases separate; demo seed profile; T4/T11 fixtures built in-test | Test matrix v1.3, plan v2.4 |
| A14 | Hardening (audit risks 3 and 8) | V3 covers every line amount, unit price and bank last-4; buyer GSTIN as vendor is schema-invalid | V3, section 14 |

## 18. v1.4 changes (23 Oct 2026 product audit)
Decided by the owner on 23 Oct 2026 (audit decisions Q1-Q11). Rows marked implemented are applied in the sections named.
| Change | Rule | Decision | Status |
|---|---|---|---|
| A printed bank account the reader leaves out is held: MISSING_REQUIRED_FIELD | K4b | Q2 | Implemented (section 4) |
| Read as an invoice but worded as a quotation, proforma or challan: CLASSIFICATION_CONFLICT | G1b | Audit A03 | Implemented (section 4) |
| AI line matches need code-checked support, not only a matching unit | M3b | Q3 | Implemented (section 7) |
| An override counts PO use; the reviewer names the PO when none was found | C4b, row 9 | Q1 | Implemented (sections 8, 11) |
| Duplicate guard at override (same file or same number and vendor); no override of CREDIT_NOTE_UNSUPPORTED | P9b, rows 9, 14, 16, 17 | Q4 | Implemented (sections 1, 11). Also: no override when the total was never read (a payment needs an amount; flagged to the owner) |
| Random reply tokens; DMARC "gray" still auto-links | D2 | Q7 | Implemented: each run has a secret random seed (never shown) from which its R-<ref><4 characters> tokens are made; runs from before v1.4 keep run-id tokens. Only a DMARC fail stops auto-linking (unchanged) |
| Buyer GSTIN is not checked: stated limitation | Section 15 | Q8 | Pending |
| Bank, vendor and sender overrides need a callback record and a second confirmation | Row 9 | Q9 | Implemented (section 11). Covers VENDOR_UNKNOWN, VENDOR_GSTIN_MISMATCH, SENDER_UNVERIFIED and BANK_DETAILS_CHANGED; a number other than the vendor-master number is refused (K4: verify by phone on the master number). The GSTIN hold is included as a vendor-identity hold (flagged to the owner) |
| Undoing an approval before export | Section 11 | Q10 | Deferred |
| Demo reset requires DEMO_ADMIN_KEY | Demo tools | Q5 | Implemented (a92657f) |
| Amounts in V3 must be printed as whole numbers of the same value, not digits inside a longer number (a misread 1300.00 was vouched for by 13,000.00) | V3b | Audit A05 (safer default, flagged to the owner) | Implemented (section 4) |
| A correction request is offered only when a hold is one the vendor can fix, and the email lists only those, in plain words without rule codes. Not offered for bank account, sender, vendor-master, duplicate or correction-link holds, an unread bank account (K4b), values not found in the text (V3) or our reader disagreeing with an invoice title (G2): those are checks on our side, and for a changed bank account the email would ask the possibly compromised sender to confirm their own change | Row 11, section 13 | Audit U03 (safer default, flagged to the owner) | Implemented (section 11) |
