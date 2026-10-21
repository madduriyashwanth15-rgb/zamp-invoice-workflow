# PS-1 Test Matrix v1.3
Status: defined before implementation. NO APPLICATION TEST HAS BEEN EXECUTED. Actual and Pass/Fail stay empty until run; each result records date, commit and model. v1.3 applies the pre-build audit decisions (spec section 17): golden and live-extraction runs, database and seed policy, tests T14-T17 and F9, T4/T11 fixture rule, A-series unit tests. v1.2.2: S12 follows the clarified lump-sum rule (spec M5); S7 also requires the inferred PO and a field-level extraction check; M5 detection unit tests added. v1.2.1 added T13 (demo identity, decision U1). Test data v2.1 for the scenario set and X1-X3 is generated in test-data/ with answer_key.json (its validator checks the data and expectations only, not the application); the volume set is not yet generated.
Pass rule: outcome matches AND blocking codes match exactly AND every expected info code is present AND every expected side effect on other runs is observed. Extra blocking codes are a failure even when the outcome is right. Spec: planning/workflow-spec.md v1.3.
Wording: CLEARED = automated outcome; APPROVED = human approval (demo display name); EXPORTED = event; payment is never represented.

## Reference data
Vendors (trusted master, fictional): V01 FreshPack Packaging (29AAFCF1234K1Z5, bank 4417, 30 days); V02 CleanCo Hygiene Supplies (29AAGCC5678M1Z2, 2290, 30); V03 Kumar Vegetables (no GSTIN, 7781, 7); V04 BlueFlame Gas Supplies (29AABCB4321P1Z8, 5530, 15); V05 Sharma Kitchen Equipment (29ABHPS9876Q1Z3, 1188, 30); V06 UrbanLinen Services (29AAECU2468R1Z6, 3365, 15). Not in master: QuickServe Traders. Every V01-V06 invoice prints its master bank account except S2.
Catalog: CONT-500 pack = 50 pcs; BAG-M bundle = 100 pcs.
POs (pre-tax; GST 18% unless stated): PO-1001 V01 (CONT-500 2,000 x 6.50; BAG-M 1,000 x 3.00; 16,000); PO-1002 V02 (floor cleaner 20 x 450; dishwash 30 x 220; 15,600); PO-7731 V03 (onions 200 kg x 30; tomatoes 100 kg x 40; 10,000; no GST); PO-1003 V04 (LPG 25 x 2,000; 50,000); PO-1004 V05 (burner servicing 4 x 1,500; gas hose 6 x 450; 8,700); PO-1005 V01 (BAG-M 2,000 x 3.00; 6,000); PO-1006 V02 (glass cleaner 40 x 120; garbage bag roll 50 x 90; 9,300); PO-1007 V05 (hood cleaning 2 x 3,500; duct cleaning 1 x 2,000; 9,000); PO-1008 V06 (napkin laundry 500 x 8.00; apron laundry 100 x 12.00; 5,200); PO-1009 V01 (CONT-500 2,000 x 6.50; 13,000). No PO has a charge line.
Execution paths: "email" = the real intake code fed through the InboundEmail adapter (automated runs use the recorded payloads in test-data/emails/; E2E tests use real email). "upload" = upload path. No path bypasses business logic.
Regression runs (A13): (1) golden run: every S and X test through the InboundEmail adapter with the recorded payloads and a mock extractor that returns answer_key expected_extraction (and, for S14, the mapping proposal in ai_mapping_ground_truth); it tests the rule engine, state effects and tokens without AI. (2) Live-extraction run: the same sequence with the real extractor, cached by sha256 + prompt version + model. The two are recorded separately, and mock results are always labelled as mock.
Databases (A13): regression runs use the test database, reset before the sequence and before each isolated test. E2E tests and the live demo use the demo database after `npm run demo:reset` (reset, then seed with the demo profile). Never the same database. Demo seed profile: registered senders for V01-V06 come from environment variables so a real address can send; the S8 sender stays unregistered; vendors stay read-only in the product.

## Scenario set (15 runs, one sequence)
Order: S1, S2, S3, [send correction email for S3], S4, S5, S6a, S6b, S7, S8, S9, S10, S11, S12, S13, S14.
| ID | Input / path | Risk covered | Key facts | Expected outcome | Blocking codes | Info codes | Side effects | Actual | Pass |
|---|---|---|---|---|---|---|---|---|---|
| S1 | FreshPack FP-2026-0418, digital; email, registered sender | Happy path | PO-1001 exact; 16,000 + 2,880 = 18,880 | CLEARED, due 11 Nov 2026 | none | PRICE_WITHIN_TOLERANCE | none | | |
| S2 | CleanCo CC-7781, layout B; email; bank account ending 0091 | Bank-detail fraud vs trusted record (2290) | All else matches PO-1002; 18,408 | ON_HOLD | BANK_DETAILS_CHANGED | PRICE_WITHIN_TOLERANCE | none | | |
| S3 | Kumar INV-552; email; PO printed "7731" | Price overcharge; PO normalisation | Tomatoes 42 vs 40 (+5.0%); 10,200 (= cap, allowed) | ON_HOLD | PRICE_OVER_TOLERANCE | none | Then correction email sent: S3 -> AWAITING_VENDOR, token issued | | |
| S4 | Kumar INV-552 "REVISED"; email REPLY carrying S3's token | Linked correction that passes | Tomatoes x 40; 10,000 | CLEARED | none | CORRECTION_OF | S3 -> SUPERSEDED | | |
| S5 | FreshPack reprint "FP/2026/418"; email | Duplicate payment, reformatted number | Same date and total as S1 | REJECTED | DUPLICATE_INVOICE | none | none | | |
| S6a | BlueFlame BF-3301; email | Partial billing | 15 of 25 cylinders; 35,400 | CLEARED | none | PRICE_WITHIN_TOLERANCE | PO-1003 consumes 15 | | |
| S6b | BlueFlame BF-3342; email | PO overrun across invoices | 12 more, 10 left; 54,000 vs 51,000 cap | ON_HOLD | QTY_EXCEEDS_PO, PO_AMOUNT_EXCEEDED | none | none | | |
| S7 | Sharma SKE-119, SCANNED (image only), no PO number; email | Scans never clear; unique PO inference | PO-1004 and PO-1007 open; lines map only to PO-1004; every critical field extracted exactly *** | ON_HOLD | SCAN_UNVERIFIED | PO_INFERRED (PO-1004) | none | | |
| S8 | QuickServe QS-55, "PO-2201"; email, UNREGISTERED sender | Unknown vendor | Not in master | ON_HOLD | VENDOR_UNKNOWN, SENDER_UNVERIFIED | none (PO, bank not evaluated) | none | | |
| S9 | FreshPack "QUOTATION", "Quote No."; email | Triage | No invoice title or label | SKIPPED | NOT_INVOICE | none | none | | |
| S10 | CleanCo CC-7790; email | Arithmetic | 9,300 + 1,674 = 10,974; printed 11,474 | ON_HOLD | ARITHMETIC_MISMATCH | none | none | | |
| S11 | FreshPack FP-2026-0431; email | Within tolerance | BAG-M 3.045 vs 3.00 (+1.5%); 7,186.20 | CLEARED | none | PRICE_WITHIN_TOLERANCE | PO-1005 consumes 2,000 | | |
| S12 | Sharma SKE-127, one line "Exhaust hood and duct cleaning as per PO-1007 (lump sum)", unit LS; email | Bundled line | Lump-sum by explicit marker ("lump sum", unit LS), detected before M1, so it is not mapped to "Duct cleaning"; 9,000 = PO-1007 remaining; 10,620 | ON_HOLD | BUNDLED_QUANTITY_UNVERIFIED | none | none | | |
| S13 | UrbanLinen UL-882, "inclusive of GST 18%"; email | Tax-inclusive | 9.44 and 14.16 -> 8.00 and 12.00; 6,136 | CLEARED | none | PRICE_WITHIN_TOLERANCE | none | | |
| S14 | FreshPack FP-2026-0440, "Takeaway box 500cc - Pack of 50"; email | Unit and description mismatch | 40 packs x 325 = 2,000 pcs x 6.50 (PO-1009); 15,340 | CLEARED * | none | LINE_MAPPED_AI_VERIFIED, PRICE_WITHIN_TOLERANCE | none | | |
* If the AI mapping proposal (M2) is cut, S14 is changed to ON_HOLD LINE_UNMAPPED before running.
** The InboundEmail adapter is always built, so S4 and X1 always run with tokens in both regression runs. Only the live email provider can be cut (plan cut 7); then E2E-4 uses T12 human link confirmation instead of a real reply.
*** S7 passes only if (a) blocking codes are exactly SCAN_UNVERIFIED, (b) PO_INFERRED points to PO-1004, and (c) every field in answer_key critical_fields equals expected_extraction (amounts, quantities and rates numerically; identifiers ignoring spaces and case; descriptions on normalised words; PO reference empty). Any misread fails S7 and is recorded as an extraction defect, even if the outcome is still ON_HOLD: e.g. GSTIN misread adds VENDOR_GSTIN_MISMATCH, unit misread UOM_UNSUPPORTED, amount misread ARITHMETIC_MISMATCH, bank digit BANK_DETAILS_CHANGED, invented PO reference LINE_UNMAPPED; a date misread adds no code but fails (c). Legibility evidence so far is tesseract only (every critical field read in 12/12 configurations); Gemini extraction of the scan is unverified until the first S7 run. Misreads seen while tuning the scan, to watch for: Q read as 0 in the GSTIN, "pcs" as "pes", merged words, split table rows.

## Supplementary PDF tests (fresh database per test; expected outcomes fixed now)
| ID | Setup | Input / path | Expected new run | Expected effect on S3 |
|---|---|---|---|---|
| X1 | S3 processed, correction email sent (S3 AWAITING_VENDOR, token issued) | Kumar INV-552 "REVISED", tomatoes x 41 (+2.5%); email reply carrying S3's token | ON_HOLD: PRICE_OVER_TOLERANCE; info CORRECTION_CANDIDATE_OF | AWAITING_VENDOR -> ON_HOLD; never SUPERSEDED (rows 15-17 refused, see T12) |
| X2 | S3 processed (ON_HOLD) | Kumar INV-552 "REVISED", tomatoes x 40 (passes every other check); fresh email, no token | ON_HOLD: CORRECTION_UNCONFIRMED | unchanged (ON_HOLD) |
| X3 | Fresh data | CleanCo CC-7795 on PO-1006, all lines exact plus "Delivery charges" 500 (+18% GST); 9,800 + 1,764 = 11,564; email | ON_HOLD: UNAPPROVED_CHARGE | n/a |

## Fault-injection tests (mocked AI and providers; no quota)
F1 schema-invalid twice -> ON_HOLD EXTRACTION_FAILED. F2 missing invoice number -> ON_HOLD MISSING_REQUIRED_FIELD. F3 total absent from text layer -> ON_HOLD EVIDENCE_NOT_FOUND. F4 AI says quotation, title "TAX INVOICE" -> ON_HOLD CLASSIFICATION_CONFLICT. F5 provider timeout/429 on all attempts -> FAILED PROCESSING_ERROR, no decision. F6 AI maps with pack size 25 vs catalog 50 -> ON_HOLD UOM_UNSUPPORTED, AI_PROPOSAL_REJECTED. F7 same webhook twice -> one run, DELIVERY_REPEAT_IGNORED. F8 attachment fetch fails 3 times -> FAILED ATTACHMENT_FETCH_FAILED. F9 AI returns the buyer's GSTIN as vendor_gstin on both schema attempts -> ON_HOLD EXTRACTION_FAILED.

## State, approval, export, correction and identity tests
| ID | Test | Expected |
|---|---|---|
| T1 | Transitions outside spec section 11 (e.g. REJECTED -> APPROVED, SUPERSEDED -> anything, exported APPROVED -> anything, CLEARED -> REJECTED) | Refused; INVALID_TRANSITION_BLOCKED |
| T2 | Note-required rows 5, 7, 9, 10, 13, 14, 16, 17 with empty note | Refused |
| T3 | Override approval of S6b | C2/C3 re-run; second confirmation required |
| T4a | Different-content invoice, same number as a CLEARED run | New: ON_HOLD POSSIBLE_DOUBLE_BILLING; original: ON_HOLD RELATED_INVOICE_DISPUTE; consumption released; original not exportable |
| T4b | Same against an APPROVED, unexported run | New: ON_HOLD POSSIBLE_DOUBLE_BILLING; original stays APPROVED with export blocked; export excludes it |
| T4c | T4b then reviewer uses "replace approved invoice" (row 17) with note | Original SUPERSEDED; new APPROVED; both audited; the new run's C2/C3 excluded the original's consumption (A8) |
| T4d | Same against an APPROVED, exported run | New: ON_HOLD POSSIBLE_DOUBLE_BILLING; approving it is refused; original unchanged |
| T5 | Draft containing an amount not in the facts brief | Send disabled |
| T6 | Approve one CLEARED run individually and three in a batch | APPROVED; approvals record display name, time, mode, batch id |
| T7 | UI copy scan | No "Paid", "Payment authorised/authorized", "Final approval"; no wording calling the reviewer "verified" or "authenticated" |
| T8 | Repeated action / double click / repeated send | No-op; ACTION_REPEAT_IGNORED; one message |
| T9 | Retry a FAILED run | Same run id; cache hit; one decision; single consumption |
| T10 | Export with CLEARED (unapproved), APPROVED, export-blocked and already-exported runs present | Only APPROVED, unblocked, unexported runs exported; export id, display name, time recorded; EXPORTED events |
| T11 | Attempt to clear or approve a second run in a chain that already has a CLEARED/APPROVED run | Pipeline: ON_HOLD POSSIBLE_DOUBLE_BILLING. Reviewer action: refused, INVALID_TRANSITION_BLOCKED (CHAIN_INVARIANT). Chain invariant holds |
| T12 | Reviewer link confirmation: on X2 (only CORRECTION_UNCONFIRMED) and on X1 (failed check) | X2: S3 SUPERSEDED, X2 APPROVED. X1: refused; S3 not superseded |
| T13 | Demo identity | A display name must be selected before any user action; the label "Demo identity — not authentication" appears wherever the name is chosen or shown; each approval, export and action stores the selected name and timestamp |
| T14 | Manual hold of a CLEARED run (row 7) with a note | ON_HOLD MANUAL_HOLD; its consumption no longer counts; note and display name recorded |
| T15 | After T4b, reject the new run (row 10) | Original's export block lifted in the same transaction; original exportable |
| T16 | S6a and a copy with a different invoice number and date (15 cylinders each, so D4 does not apply) decided concurrently on PO-1003 | Serialised: one CLEARED consuming 15; the other ON_HOLD QTY_EXCEEDS_PO, PO_AMOUNT_EXCEEDED; consumption never exceeds what one run cleared |
| T17 | Upload S1 into a fresh database (A1) | CLEARED; K3 recorded "not evaluated: internal upload by <display name> (demo identity)"; run shows source = upload |
T4a-d and T11 fixtures are built in the test from existing fixtures through the mock extractor (e.g. S1, then S1 with a different total); no new PDFs (A13).

## Rule unit tests
Normalisation (invoice and PO numbers); token parsing (valid same-chain token links; token for another chain or from an unregistered sender does not; revision marker alone does not); D1-D4 and chain invariant; P2 (PO_INFERRED, PO_AMBIGUOUS, PO_NOT_FOUND); M1 token rule; M3 conversions; M5 detection (marker phrase, "Lump-Sum", "lumpsum", unit LS -> lump-sum; regression: an ordinary line citing a PO number, e.g. "LPG cylinder 19 kg commercial (refill) as per PO-1003", maps normally and clears; "bundle of 100" pack wording and plain service lines -> not lump-sum; detection runs before M1, shown by S12 not mapping to "Duct cleaning"); M5 amounts (equal, lower, higher); M7 (keyword with no PO charge line -> UNAPPROVED_CHARGE; keyword with PO charge line within tolerance -> accepted; over tolerance -> UNAPPROVED_CHARGE; amount-only line without keyword -> LINE_UNMAPPED with "possible charge" evidence); T2/T3; C1 boundaries (+2.00% clears, +2.01% holds); C2/C3 boundaries and mapped-lines-only; V2 rounding; K4 last-4 and BANK_NOT_SHOWN. A-series (spec v1.3): A3 money (2,000 x 3.045 = 6,090.00 exactly; C1 inclusive cross-multiplication on S13 prices); A4 normalisers (stopwords, plural units, "pcs" kept) and per-line order (charge and lump-sum lines are never mapped: X3 and S12 carry no LINE_UNMAPPED); A5 codes (MANUAL_HOLD; AI_PROPOSAL_REJECTED blocking with its partner code; a duplicate M4 mapping -> LINE_UNMAPPED); A7 D1 exact to the paisa (a Rs 0.01 difference is not a duplicate) and D2/D3 precedence; A9 T3 (stated exclusive but only inclusive arithmetic consistent -> TAX_BASIS_UNCLEAR; tax shown with no basis -> TAX_BASIS_UNCLEAR); A14 V3 extension (S1 with an internally consistent misread of line 2, rate 3.05 and amount 3,050 with totals adjusted -> EVIDENCE_NOT_FOUND, not CLEARED).

## End-to-end tests (live deployment, real email)
All E2E tests start from `npm run demo:reset`. E2E-1 email S1 from the registered address -> run appears without clicks -> CLEARED. E2E-2 email S8 from the unregistered address -> ON_HOLD VENDOR_UNKNOWN, SENDER_UNVERIFIED. E2E-3 upload S3 -> ON_HOLD PRICE_OVER_TOLERANCE (K3 not evaluated: internal upload). E2E-4 S3 hold -> correction email with token sent -> real reply with S4 -> S4 CLEARED, S3 SUPERSEDED -> reviewer (demo display name) approves S4 -> export lists S4. E2E-5 (deferred, R2-3) sync inbox.

## Acceptance checks (recorded manually)
UI-1 run view shows stages live. UI-2 dashboard: history, filters, cleared vs approved vs exported clearly distinct, export, demo-identity label visible. UI-3 empty, loading, error, partial-failure states. DEP-1 live URL in a private window. DATA-1 README states assumptions and limitations. REH-1 three rehearsals. VID-1 video <= 5 min, own voice, happy path plus at least one edge case.

## Volume set (50; not yet generated)
About 70% clean, 10% within-tolerance, 10% over tolerance, 5% duplicates (reformatted), 5% arithmetic or missing PO; also keyword charge lines, digital inferred POs and a few scans (always held). Generated only after separate approval. Metrics on this test set only. At most 3 runs all week.
