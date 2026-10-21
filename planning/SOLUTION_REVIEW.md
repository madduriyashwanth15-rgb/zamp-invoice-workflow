# SOLUTION_REVIEW.md
Last updated: 22 Oct 2026 (spec v1.3: pre-build audit resolved). Status: design frozen; test data v2.1 validated (data and expectations only); no application code; no application test executed.

## A. Current solution
Email-triggered invoice workflow. AI reads and classifies; deterministic code checks vendor, sender, bank, duplicates and corrections, PO, lines, charges, tax basis, tolerance and consumption. Automated outcomes: Cleared, On hold, Rejected, Skipped, Failed, each with reason codes and evidence. A reviewer, identified by a self-selected display name labelled "Demo identity — not authentication", approves cleared invoices (individually or in batches) before export and resolves holds with notes. Corrections link only through a reply carrying our token and only when they pass every check. Disputes block export. Payment is never represented. $0 stack: Next.js on Vercel Hobby, Neon Free, Gemini free tier, Resend Free.

## B. Requirements traceability (every row has at least one test)
| ID | Requirement | Src | Implementation (spec v1.3) | Tests |
|---|---|---|---|---|
| R1 | Real input | E | Stage 0 | E2E-1, E2E-3, F7, F8 |
| R2 | Runs end to end | E | Stages 0-9 | S1-S14, E2E-1..4 |
| R3 | 2-4 non-trivial edge cases | E | Sections 4-8 | S2, S3, S5, S6b, S7, S10, S12, X3 |
| R4 | Reasoned decision, steps visible | E/B | Sections 9-10, audit | All S/X; UI-1 |
| R5 | Live run view | E | Run page | UI-1, E2E-1 |
| R6 | Dashboard | E | Step 13 | UI-2, T6, T10 |
| R7 | Intuitive UI | E | Review screen, states | UI-3, REH-1 |
| R8 | Live link | E | Vercel | DEP-1 |
| R9 | Video | E | Saturday | VID-1 |
| R10 | Runs live in interview | E | Fallbacks, rehearsal | REH-1, E2E-3 |
| R11 | Realistic self-made data | E | Test data v2 | DATA-1 |
| B1 | Approved vendors | B | K1-K4 | S2, S8 |
| B2 | PO amounts | B | C2-C3 | S6b |
| B3 | Tolerance | B | C1 | S3, S11, unit |
| B4 | Duplicates | B | D1 | S5 |
| B5 | Split PO | B | C4 | S6a, S6b |
| B6 | Close but not exact | B | C1 | S11 |
| B7 | Missing information | B | V1 | F2 |
| B8 | Scanned images | B | V4 | S7 (exact codes, PO-1004 inferred, field-level extraction check) |
| B9 | Implied PO | B | P1, P2 | S3, S7, unit |
| B10 | Tax embedded vs separate | B | T1-T3 | S13, unit |
| B11 | Bundled vs itemised | B | M5 (explicit markers, detected before M1) | S12, unit (incl. PO-number regression) |
| G1 | AI mappings are proposals | G | M2-M3 | S14, F6 |
| G2 | Code validates arithmetic and rules | G | V2, T2-T3, C1-C3 | S10, S13, unit |
| G3 | No auto-clear on missing field, ambiguous PO, unmapped line, failed check | G | P2, M7, section 9 | F2, F6, X3, S10, unit |
| G4 | Supported scope explicit; unsupported held | G | M5-M7, T2-T3, section 15 | F6, X3, unit |
| G5 | Duplicates vs corrections separate | G | D1-D4 | S4, S5, X1, X2, T4a-d |
| G6 | Every hold has code and evidence | G | Section 10 | All hold tests |
| G7 | No unexecuted test claimed | G | Matrix columns | Process |
| G8 | Scans never auto-clear | G | V4 | S7 |
| G9 | Bank check vs trusted record | G | K4 | S2, unit |
| G10 | Unapproved charges: keywords + PO comparison; anomalies only supporting | G | M7 | X3, unit |
| G11 | Cleared / Approved / Exported / Paid distinct | G | Section 12 | T6, T7, T10, UI-2 |
| G12 | Full state machine, notes, retries, idempotency | G | Section 11 | T1, T2, T8, T9, F7 |
| G13 | Correction link only via reply token | G | D2 | S4, X2, unit, E2E-4 |
| G14 | Failed corrections never supersede | G | D2, rows 15-17 guards | X1, T12 |
| G15 | Human approval before export (individual and batch, audited) | G | Rows 6, 9, 14; exports | T6, T10 |
| G16 | Correction against cleared invoice returns it to hold; disputes block export; approved never silently replaced | G | D3, rows 8, 17, export guard | T4a-d, T10 |
| G17 | Chain invariant | G | P9 | T11 |
| G18 | Demo identity: display name selected, labelled "Demo identity — not authentication", recorded with timestamp, never presented as verified | G | P10, section 12 | T13, T7, UI-2 |
| D1 | Email trigger with fallback | D | Stage 0, upload | E2E-1..3 |
| D2 | Review loop with fact-checked drafts | D | Section 13 | T5, E2E-4 |

## C. Alternatives considered
PS choice, stack, provider, orchestration, extraction, matching, assistant scope and Neon integration as previously logged. Revision-marker linking rejected in favour of reply tokens. Direct export of cleared invoices rejected in favour of explicit human approval. Real authentication rejected for this submission in favour of a clearly labelled demo identity (U1): saves setup time and a dependency; the limitation is stated rather than hidden.

## D. Consistency checks
v1.1 and v1.2 passes fixed twelve contradictions (logged in earlier versions of this section). v1.2.1: U1 applied to spec (P10, data model, sections 11-12, 15), test matrix (T6, T7, T10, T13, UI-2, E2E-4), plan (Step 5, Step 11, Step 13, protected list). No new contradiction found.
v1.2.2: M5 clarification applied to spec (header, stage 7, M5, settings, section 15), test matrix (header, pass rule, S7, S12, note ***, unit tests), plan (status, MVW, Step 1, 09:45 review, Step 4, Step 9) and the test-data README. No new contradiction found.
Pre-build audit (22 Oct, Claude Code in Cursor, read-only): found 11 spec gaps and 5 plan or matrix mismatches that the v1.2.x passes missed, so the earlier "no new contradiction found" was wrong. Several gaps had been filled silently by the test oracle. All resolved in spec v1.3 (decisions A1-A14, section 17); the oracle's choices are now written into spec section 16. Next independent check: after Phase C, compare the rule engine with spec section 16 rule by rule.

## E. Decisions (final)
1. Correction linking: reply containing our reference token only; otherwise CORRECTION_UNCONFIRMED.
2. Export: explicit human approval required; individual and batch; auditable who (display name) and when.
3. Correction against a cleared invoice: original returns to hold and cannot be exported while unresolved; approved invoices never silently replaced.
4. Extra charges: keyword rules plus deterministic PO comparison; anomalies are supporting signals; unapproved charges hold UNAPPROVED_CHARGE.
5. X1, X2, X3 included as PDF tests with fixed expectations.
6. U1 reviewer identity: self-selected display name, labelled "Demo identity — not authentication", recorded with timestamp; not verified identity; no production access control.
7. M5 lump-sum lines: explicit markers only ("lump sum", "lumpsum", unit LS; configurable), detected before M1; a PO number alone is never a marker. S12 stays ON_HOLD BUNDLED_QUANTITY_UNVERIFIED.
8. S7: image-only, made legible; passes only with exactly SCAN_UNVERIFIED, PO_INFERRED to PO-1004, and every critical field extracted correctly; any misread fails the test.
9. Pre-build audit decisions A1-A14 (spec section 17). Most consequential: uploads are internal actions (K3 not evaluated; K1, K2, K4 still apply); every check is built in the rule engine before scenarios are recorded; unit prices and quantities are exact decimals; the oracle's normalisation and rule order are binding; D3 excludes an unexported counterpart's consumption so replacement is reachable; the InboundEmail adapter is always built.
Review-2: R2-1, R2-2, R2-4, R2-5, R2-6 accepted; R2-3 deferred until E2E-1 passes.

## F. Weaknesses and risks
1. Thursday is the critical day (MVW is the hard milestone).
2. Free-tier AI limits unpublished; mitigated by caching, one call per invoice, capped volume runs.
3. Live email delay in the interview; mitigated by rehearsal, warm-up email and upload fallback.
4. Scanned extraction accuracy; scans always held, so a misread cannot clear on its own. Legibility measured with tesseract only (every critical field read in 12/12 configurations); Gemini extraction of S7 unverified until its first run; misreads fail S7 rather than pass quietly.
5. Residual: an AI misread on a text-layer invoice that is internally consistent and matches the PO. Reduced by A14 (V3 now checks every line amount, unit price and bank last-4 against the text layer); a misread equal to another value printed on the page can still pass.
6. Synthetic data is not independent evidence; claims limited to our test set.
7. Demo identity offers no security: anyone with the link can act under any name. Acceptable for a private demo; stated explicitly in the UI and the video.
8. Lump-sum lines without an explicit marker are matched like any other line and are normally held; residual: one whose wording, price and quantity match a single PO line clears against that line. Documented in spec section 15.
9. Concurrent decisions on one PO: serialised by PO and chain locks inside the stage 8-9 transaction; must be proven by T16 on Neon in Phase D, not assumed.
10. Uploads bypass the sender check by design (A1), and with demo identity anyone with the link can upload. Stated in the UI and the video; production needs authenticated staff.

## G. Open decisions
None known. Step 0 facts (Gemini model id and free-tier limits, Neon transaction behaviour) are verified in Phases D and E.
