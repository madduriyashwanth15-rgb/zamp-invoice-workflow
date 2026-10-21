# PS-1 Implementation Plan v2.4
Status: spec v1.3 frozen 22 Oct 2026 after the read-only pre-build audit; test data v2.1 validated (data and expectations only). No application code yet. Priorities: P0 must, P1 should, P2 could. Phases follow the audit's sequence (A-J), mapped onto the calendar.

## How we build
- Claude Code in Cursor is the execution agent: one phase per prompt, then it stops and reports (format in CLAUDE.md). The mentor reviews the report and issues the next prompt.
- The whole rule engine (stages 2-9, every check in spec sections 4-8) is built at once as pure TypeScript and proven by the golden run before any UI. It is a port of the oracle plus the v1.3 rules in spec section 16-17.
- Work that needs no accounts goes first; Step 0 (accounts) runs in parallel with Phase C.
- Nothing is recorded as passing unless it was executed; mocks are labelled.

## Phases
| Phase | When | Build | Acceptance (executed and recorded) | P |
|---|---|---|---|---|
| A | Thu 01:30 (done) | Audit decisions A1-A14 into spec v1.3, matrix v1.3, plan v2.4; CLAUDE.md | Docs in planning/ | P0 |
| B | Thu, first Cursor session (about 1 h) | Git repo; Next.js + TypeScript + Tailwind + Vitest scaffold; domain foundation in src/domain: money and decimals, normalisers, lump-sum and charge detection, reason codes, settings and reference loaders, extraction schema, fixture loader; validator reproduced locally | Unit tests pass (normalisers, money incl. 3.045 and C1 boundaries, M5 list, schema parses all 18 expected extractions and rejects buyer GSTIN as vendor, reference data equals the matrix); build and lint pass; validator 263 passed + 1 skipped (278 if tesseract is installed) | P0 |
| Step 0 | Thu 09:00, user in the browser, parallel to C | GitHub repo; Vercel; Neon with two databases (test, demo); AI Studio API key with no billing; Resend; record the real Gemini model id and free-tier limits | Keys in .env.local and Vercel, never committed | P0 |
| C | Thu 09:00-13:00 | Rule engine stages 2-9 (pure), mock extractor, mapping-proposer interface, InboundEmail adapter (recorded payloads, token parsing), in-memory store for the golden harness | Golden run 18/18 (pass rule); mutation checks from validation_report sections 6-8; A-series unit tests | P0 |
| D | Thu 13:00-16:00 | Prisma schema and migrations (Neon test DB); seed with test and demo profiles; state machine (17 rows, notes, INVALID_TRANSITION_BLOCKED); stage 8-9 transaction with PO and chain locks; audit events; golden run re-pointed to Postgres | T1, T2, T9, T16; golden run 18/18 on Postgres | P0 |
| E | Thu 16:00-18:30 | Gemini extractor behind the interface: versioned prompt, schema validation, retries, cache; M2 mapping proposer | F1, F2, F4, F5, F9 (mocked provider); live extraction of S1, S7, S14 recorded (S7: 0 critical-field diffs and PO-1004 inferred, or the diffs listed) | P0 |
| F | Thu 18:30-21:00 | Upload, pipeline runner, run view with live stages; deploy to Vercel | Thursday milestone (below) | P0 |
| H | Fri 09:00-12:00 | Live email: Resend inbound webhook -> adapter (fast 200, process after), attachment fetch, idempotency | F7, F8; E2E-1, E2E-2 | P0 |
| I | Fri 12:00-17:30 | Demo identity picker; review screen; override, reject, hold, stop waiting (notes); correction email with token (send or mark sent manually); link confirmation (row 16) and replacement (row 17); individual and batch approval; guarded export | T3-T8, T10, T12-T15, T17; E2E-3, E2E-4 | P0 |
| Volume | Fri 17:30-18:30 | Volume set, only if approved | Accuracy table on test data | P1 |
| J | Sat 09:00-11:30 | Dashboard (history, filters, cleared / approved / exported distinct, export list, counts labelled test data, identity label) and a visual refinement pass | UI-1, UI-2, UI-3, T7 | P0 |
| Assistant | Sat 11:30-13:30 | Plain-English draft editing with the fact check (2 h box; becomes visual polish time if cut) | Works or cut | P2 |
| Regression | Sat 13:30-17:00 | Golden and live-extraction regression on the live URL; demo reset script; DEP-1 | All S, X, F, T, E2E recorded | P0 |
| Demo | Sat 17:00-21:00 | Freeze; demo script; REH-1 (3 rehearsals); VID-1 | Video saved | P0 |
| Buffer | Sun 09:00-11:30 | Fixes only; submit by 12:00 | Submitted | P0 |

## Thursday 21:00 milestone
- Golden run 18/18 on Postgres with the full rule engine.
- T1, T2, T9 and T16 pass.
- Extractor: F1, F2, F4, F5, F9 pass; live S1, S7, S14 extraction recorded.
- Live URL: upload S1 -> CLEARED and S3 -> ON_HOLD, with stages visible in the run view.
Checkpoint 17:00: if behind, move the deploy to Friday 09:00 and keep the run view minimal. Never cut the golden run, the state machine or the extractor.
Checkpoint Friday 18:00: if the Kumar loop (E2E-4 or T12) is not working, cut the assistant and the volume set immediately.

## Final cut order
Protected (may move days, never dropped): every check in spec sections 4-8; reason codes with evidence; state machine with notes; transactions, locks and audit; golden and live-extraction regression; run view; approval and guarded export; demo identity labelling and recording; the video.
Cut only when behind, in this order:
1. Assistant panel.
2. Sync-inbox fallback (deferred, R2-3).
3. Volume set: 50 -> 20 -> none.
4. Dashboard charts (keep counts and lists).
5. M2 AI mapping (S14 changed to ON_HOLD LINE_UNMAPPED before running).
6. Live email sending (keep "copy text and mark sent manually", labelled; token still issued).
7. Live email provider (the InboundEmail adapter stays; E2E-4 uses T12 link confirmation; limitation stated in the video).
