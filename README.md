# Supplier invoice workflow (Zamp PS-1, Finance / AP)

Vendors email invoices (or a reviewer uploads them). Each one is read, checked against the vendor master and the
purchase order, and decided: **Cleared by checks**, **On hold** with the reasons, **Rejected** (duplicate) or
**Skipped** (not an invoice). A person approves cleared invoices for the payment list and exports it for finance.
All data is fictional (SpiceRoute Kitchens and its suppliers).

## How a decision is made

```
email / upload ─▶ 0 intake ─▶ 1 read (AI) ─▶ 2-9 checks (code) ─▶ decision ─▶ reviewer ─▶ payment list
```

- **The AI only reads.** One call turns the PDF or image into structured fields (`src/server/extractor`). A second
  call is made only when a line cannot be matched to the PO by wording, and it only *proposes* a match.
- **Code decides.** Every value read is searched for in the PDF's own text (V3); vendor, sender and bank details are
  checked against the vendor master (K1-K4); duplicates and corrections by normalised invoice number (D1-D4); lines,
  prices, quantities and amounts against the PO with exact decimal and paise arithmetic (M, C, T rules). Rules:
  `planning/workflow-spec.md`; engine: `src/domain/engine/evaluate.ts`.
- **People approve.** Nothing reaches the payment list without a reviewer. Every action needs a display name
  (demo identity, not authentication) and some need a note; every change and refusal is in the audit history.
- **Corrections close the loop.** A correction request carries `[Ref R-A0003]`. A reply with that reference from the
  vendor's registered address that passes every check replaces the held invoice automatically; without it, a
  reviewer confirms the link.

## Run it (Windows PowerShell)

```powershell
npm install
copy .env.example .env.local   # then fill in what you have; every variable is optional for a local run
npm run dev                    # http://localhost:3000
```

Without `DATABASE_URL` records live in memory (cleared on restart). Without `GEMINI_API_KEY` and `GEMINI_MODEL` the
**MOCK extractor** is used: it does not read documents, it returns the answer key for the 18 test files by name. The
header of every page says which of these is active.

To try it: open **Demo emails** and send the recorded emails in order (S3's correction must be requested and marked
sent before S4), or upload any PDF from `zamp-ps1-test-data-v2.1/test-data/invoices`.

## Tests

```powershell
npm test            # domain, golden run (18 scenarios), state machine, extractor (MOCK provider), intake, UI formatting
npm run test:pg     # the whole suite on PostgreSQL (TEST_DATABASE_URL in .env.test.local, a TEST database only)
npm run test:live   # real Gemini calls on S1, S7, S14 (GEMINI_* in .env.local); writes reports/live-extraction.json
npm run typecheck; npm run lint; npm run build
```

The golden run feeds every recorded email through the same intake adapter the app uses and applies the test
matrix pass rule; it must also agree with the independent oracle (`oracle_results.json`).

## Architecture

| Layer | Where | Notes |
|---|---|---|
| Rules, states, actions | `src/domain` | Pure TypeScript; no framework, database or network imports |
| Store | `src/domain/runs/memory-store.ts`, `src/server/db/pg-store.ts` | Same contract; writes serialised by one Postgres advisory lock; decisions re-checked at commit (T16) |
| AI | `src/server/extractor` | Versioned prompts, schema validation, retries, cache by file hash + prompt + model |
| Intake | `src/server/email-intake.ts`, `src/app/api/inbound/resend` | One run per attachment; repeats ignored; fetch failures recorded |
| App | `src/app`, `src/ui` | Next.js; dashboard, run view with every stage, demo tools, rules page |

## Assumptions and limitations

- Text-layer evidence only: scans and photos are always held for a human check (SCAN_UNVERIFIED).
- INR only. GST is checked for consistency, not for tax law. Unit conversions only through the catalog.
- Lump-sum lines are recognised only by explicit markers and always held. Credit notes and discounts are not processed.
- Charge wording outside the keyword list ends as LINE_UNMAPPED (still held).
- Disputes against an exported invoice need the company's credit-note process: the new invoice can only be held or rejected.
- Reviewer identity is a self-selected display name, recorded but unverified. Anyone with the link can upload and
  approve; production needs authenticated staff and role checks.
- Uploads are trusted as internal actions (no sender check).
- V3 is a presence check: it catches values the document does not contain, not a misread that matches another value on the page.
- "Paid" is never shown: payment happens in finance's own process after export.
- Accuracy figures describe this synthetic test set only. Free-tier AI content may be used by the provider: use fictional data only.
- Correction emails are drafted by code and copied by the reviewer ("Mark as sent manually"); sending is not wired up.
- The `/demo` page simulates the email provider by replaying recorded test emails; intake and checks are the real ones.

## Secrets

Keys live only in `.env.local` / `.env.test.local` and the Vercel project settings (all git-ignored).
`.env.example` lists the variable names with placeholders.
