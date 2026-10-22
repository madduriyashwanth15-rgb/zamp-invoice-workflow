# Overnight build status (mentor, 22 Oct 2026)

Written by the mentor session while you slept. Nothing here is committed: every file is in your folder as an
uncommitted change. Every result below was actually run, in the mentor's Linux workspace (Node 22, a real
PostgreSQL 16 server, Chromium). It has NOT yet been run on your Windows machine: that is the first step below.

## Where we are against the plan

| Phase | Status | Evidence (run tonight) |
|---|---|---|
| C rule engine, mock extractor, InboundEmail adapter, in-memory store | Done | Golden run 18/18 pass rule, 18/18 equal to the oracle |
| D Postgres store, transactions, locks, audit, golden on Postgres | Done, with two deviations (below) | Whole suite on Postgres: 226/226. Golden run on Postgres equal to in-memory record for record. T16 across two connection pools |
| E Gemini extractor, retries, cache, M2 proposer | Built and tested against a MOCK provider | F1, F5, F9, cache, 429/503 retry. Live run waits for your API key |
| F upload, pipeline runner, run view | Done locally | Upload S1 in the browser -> CLEARED with all stages shown |
| H email intake | Adapter and Resend webhook built; provider MOCKED in tests | F7, F8, NO_ATTACHMENT, UNSUPPORTED_FILE; Svix signature check; webhook event -> CLEARED run with a stubbed Resend API |
| I review actions | Done in the UI | Browser flow: batch approve, export, reject with note, request correction |
| J dashboard | First version done | Filters: needs a decision / waiting / cleared / approved / exported / closed. Rules page (spec 8 settings, vendor master, POs, catalog) |

## Test results (actual output)

```
npm test           Test Files 14 passed (14)   Tests 226 passed (226)     (Postgres checks included: TEST_DATABASE_URL set)
npm run test:pg    Test Files 14 passed (14)   Tests 226 passed (226)     (whole suite on PostgreSQL 16)
npm run test:live  Tests 4 skipped (4)                                     (no Gemini key yet)
npm run typecheck  clean
npm run lint       clean
npm run build      success (Next.js 16.4.2, Turbopack)
```
On your machine without `.env.test.local`, expect `npm test` to show `Tests 222 passed | 4 skipped (226)`: the 4 skipped are the Postgres-only checks.

Meaningfulness checks (each re-run with the safeguard switched off, then restored):
- T16 in memory and T16 across two app instances on Postgres both FAIL without the commit-time re-check (both invoices clear, the PO is over-billed) and PASS with it.

## What was built tonight

- Store port made async with an append-only audit log; Postgres store (`src/server/db`) with one schema file, an
  append-only trigger on `audit_events`, and a Postgres extraction cache.
- Gemini extractor (`src/server/extractor`): versioned prompt `extract-v1`, transport retries (3, backoff 0.5 s and
  1 s), schema retries (2, errors fed back), buyer-GSTIN guard, cache by sha256 + prompt version + model,
  M2 mapping proposer. The API key goes in a header, never the URL.
- App: dashboard (`/`), run view (`/runs/<id>`), recorded-email replay and reset (`/demo`), API routes under `/api`.
  Uploads answer immediately and read in the background (`after()`); the run view polls while reading.
- Email intake adapter (`src/server/email-intake.ts`): one run per attachment, 3 fetch attempts, skips recorded.
- Correction request: the email is built by code from the run's own findings with the `[Ref R-...]` token; you
  copy it and mark it sent manually (sending is not connected yet, labelled in the UI).
- Recovery: a run stuck in PROCESSING for 3 minutes becomes FAILED PROCESSING_ERROR (row 3) and can be retried.
- Resend inbound webhook (`/api/inbound/resend`): Svix signature check, answers at once, then loads the email and
  attachments from the Resend API (3 attempts; if it still fails a FAILED ATTACHMENT_FETCH_FAILED run is recorded,
  so no email disappears). Demo seed profile: `DEMO_SENDER_V01..V06` add your own address as a registered sender.
- Rules page (`/settings`), README with run steps, assumptions and limitations (DATA-1).

## Independent review (a separate agent that had not seen the work) and the fixes

It confirmed 7 defects by running them and suspected 2 more; none was covered by the existing tests. All are fixed.
Each has a regression test in `tests/review-findings.test.ts`, and all 10 of those tests were run against the
pre-fix code and failed there.

1. High: a reply token still linked after its invoice was rejected or replaced. Now a token is valid only while its run is ON_HOLD or AWAITING_VENDOR (spec A12).
2. High (spec gap, your call): approving a lump-sum invoice used up none of the PO, so an itemised invoice for the same work could then clear. Now an approved lump-sum line counts as a PO-level amount (line 0) in C3 and in the M5 remainder.
3. Medium: link confirmation (row 16) and replacement (row 17) approved without re-checking PO limits. They now re-run C2/C3 and ask for a second confirmation like an override. Row 16 is refused when no held invoice is left.
4. Medium: rejecting one disputing invoice unblocked the original while another dispute was waiting for the vendor. Fixed.
5. Medium: a damaged PDF in an email stranded the good attachment in RECEIVED. Damaged files are now SKIPPED UNSUPPORTED_FILE, the others still process, and runs that never started are failed by the sweep and can be retried.
6. Security (suspected): K3 trusted the From address. A reply that fails DMARC (Resend reports it) is now SENDER_UNVERIFIED and never links. Tokens now carry a 4-character suffix from the random run id (`R-A0003K7Q2`).
7. Wording: every displayed reviewer name now says "(demo identity)", and two sentences that talked about payment were rewritten. A new test scans all UI copy for "paid", "payment authorised" and "final approval".
8. Retry is refused for a run with no stored file, and the API no longer accepts "sent" for corrections (nothing is sent yet).
9. P5: if the AI line-proposal call cannot be reached, the run now FAILS (retryable) instead of being held as unmapped. The stuck threshold went from 3 to 8 minutes, so a slow extraction is not cut off. Download filenames outside Latin-1 work.

Areas the reviewer traced with no issue: the commit-time re-check (no wrong-decision interleaving), Postgres
locking and write order, the bigint codec, money arithmetic (no floats anywhere), Svix verification.

## A real bug found and fixed tonight

Replaying the 15-email sequence into the running app left S1 stuck in PROCESSING, and S5 (its duplicate) then
cleared. Cause: the commit-time re-check compared every other run, so unrelated invoices arriving together kept
invalidating each other until the re-evaluation limit ran out. Fix: the re-check now covers only what the
decision depends on (same vendor, same POs, reply tokens), and a run that still cannot settle ends FAILED with a
reason instead of staying in PROCESSING. Regression tests in `tests/concurrency.test.ts` (S1 and S5 racing:
exactly one CLEARED, one REJECTED DUPLICATE_INVOICE). After the fix the replay gives the expected outcome for all 15.

## Decisions I made that need your approval

1. **Plain SQL with `pg` instead of Prisma** (plan phase D named Prisma). The store loads state, runs the domain
   function and writes the changes inside one transaction; that needs raw SQL for advisory locks anyway, and it
   avoids Prisma's generate step and engine setup on Windows and Vercel. Reversible.
2. **A11 locks as one transaction-scoped advisory lock** for all writes, instead of separate PO and chain locks.
   Stricter than needed and cheap at this volume (AI calls happen outside the lock). T16 proves it.
3. **Correction emails are not sent yet**: draft built by code (no AI phrasing) plus "Mark as sent manually", which
   the spec allows. Real sending comes with Resend.
4. **Demo email replay** (`/demo`): replays the recorded test emails through the real intake as if the vendor sent
   them. The provider is simulated and labelled; everything after it is real. This makes the S3 -> S4 correction
   loop demonstrable before Resend is set up. `npm run demo:reset` empties the demo database (`/demo` has the same button).
5. **Every correction request gets a new token** (`R-A0003` plus a 4-character suffix), earlier tokens stay valid
   while the invoice is held or waiting (A12). A reply that fails DMARC never links (K3, review item 6).
6. **Upload of the same file within 60 s** is logged with the existing event code DELIVERY_REPEAT_IGNORED.
7. **ATTACHMENT_FETCH_FAILED runs offer no retry** (there is no file to retry with; the vendor must resend).
8. **Lump-sum consumption** (review item 2): an approved lump-sum line uses up its amount of the PO. The spec is
   silent on this; the alternative is to leave it uncounted and accept the double-billing gap.
9. **Gemini Interactions API by default** (`GEMINI_API=generate_content` switches to the legacy call), store=false,
   thinking level low, temperature left at the default as Google advises for Gemini 3.
10. **Font**: Atkinson Hyperlegible Next (OFL, from npm, no build-time download), chosen because it keeps 0/O and
   1/l apart in invoice numbers and GSTINs.
11. Phase B open questions, answered as: doc_type enum as built; optional igst kept; C1/C3/M7 tolerance from
   settings (the spec's 102/98 is the 2% default, spec text to be synced); approval limit in paise; registered
   senders separated by "|"; restore validator outputs from git after running the validator.

## Not done yet (in order)

1. Your Step 0 accounts (below). Then the live Gemini run (`npm run test:live`) to confirm the real API answers
   in the shape the transport expects. Until then the Gemini wire format is checked only against Google's docs.
2. Resend account, inbound address and webhook secret, then one real email end to end (E2E-1, E2E-4). Sending
   correction emails through Resend is not built (the vendors' addresses are fictional; "mark sent manually" stays).
3. Deploy to Vercel with the Neon demo database.
4. Planning doc sync (spec 16.4 tolerance text, Phase B answers, the decisions above once you approve them).

## Your morning steps

1. Paste the prompt in `reports/morning-prompt.md` into Claude Code. It installs the new packages, runs every check
   on Windows, and commits only if all pass.
2. Step 0 in the browser: GitHub repo, Vercel, Neon (two databases: test and demo), AI Studio key with no billing.
   Put the keys in `.env.local` (copy `.env.example`); never paste them into chat.
3. Tell me when done; next is the live extraction run and the deploy.
