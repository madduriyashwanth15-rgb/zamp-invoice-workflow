# Supplier invoice workflow (Zamp PS-1, Finance / AP)

Vendors email invoices (or a reviewer uploads them). Each one is read, checked against the vendor master and the
purchase order, and decided: **Cleared by checks**, **On hold** with the reasons, **Rejected** (duplicate) or
**Skipped** (not an invoice). A person approves cleared invoices for the payment list and exports it for finance.
The companies, invoices and purchase orders (SpiceRoute Kitchens and its suppliers) are fictional test data. On the
live demo, my own mailboxes are registered as vendor sender addresses so that I can email invoices in for testing.

## How a decision is made

```
email / upload ─▶ 0 intake ─▶ 1 read (AI) ─▶ 2-9 checks (code) ─▶ decision ─▶ reviewer ─▶ payment list
```

- **The AI only reads.** One call turns the PDF or image into structured fields (`src/server/extractor`). A second
  call is made only when a line cannot be matched to the PO by wording, and it only *proposes* a match.
- **Code decides.** Every value read is searched for in the PDF's own text (V3), the invoice date included (V3c);
  vendor, sender and bank details are checked against the vendor master (K1-K4); duplicates and corrections by
  normalised invoice number (D1-D4); lines, prices, quantities and amounts against the PO with exact decimal and paise
  arithmetic (M, C, T rules). Rules: `planning/workflow-spec.md`; engine: `src/domain/engine/evaluate.ts`. The review
  screen shows how long the reading and the checks took on that invoice, as measured (the checks take milliseconds).
- **People approve.** Nothing reaches the payment list without a reviewer. Every action needs a display name
  (demo identity, not authentication) and some need a note; every change and refusal is in the audit history.
- **Corrections close the loop.** The app emails the vendor a correction request written by code from the findings,
  carrying `[Ref R-A0003K7Q2]`, with replies going to the AP inbox. A reply with that reference from the vendor's
  registered address that passes every check replaces the held invoice automatically; without it, a reviewer
  confirms the link. Without email sending configured, the reviewer copies the text and marks it sent manually.

Live: https://zamp-invoice-workflow.vercel.app (Vercel, functions in Singapore next to the Neon database). Email
invoices to the AP inbox shown on the Demo inbox page; sample invoices can be downloaded there.

## Run it (Windows PowerShell)

```powershell
npm install
copy .env.example .env.local   # then fill in what you have; every variable is optional for a local run
npm run dev                    # http://localhost:3000
```

Without `DATABASE_URL` records live in memory (cleared on restart). Without `GEMINI_API_KEY` and `GEMINI_MODEL` the
**MOCK extractor** is used: it does not read documents, it returns the answer key for the 18 test files by name. The
foot of the side menu says which of these is active.

To try it: open **Demo inbox** and send the recorded emails in order (S3's correction must be requested before S4),
or upload any PDF from `zamp-ps1-test-data-v2.1/test-data/invoices`.

Settings (all optional; `.env.example` lists them):

| Variable | Effect |
|---|---|
| `DATABASE_URL` | Neon Postgres (demo database). Without it: in memory |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | The real reader. Deployed: `gemini-3.5-flash-lite` (see below). Without them: MOCK |
| `GEMINI_FALLBACK_MODEL` | Backup model for the remaining attempts after an overload, quota or timeout error (deployed: `gemini-3.8-flash`) |
| `GEMINI_TIMEOUT_MS` | Per-call timeout, 5-90 s (default 60 s) |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | Inbound email: Resend calls `/api/inbound/resend` (signature checked) |
| `AP_INBOX_ADDRESS` | With `RESEND_API_KEY`: correction emails are sent by the app, replies go to this inbox |
| `RESEND_FROM` | Sender of correction emails. Default: Resend's test sender, which without a verified domain only delivers to the Resend account's own address |
| `DEMO_ADMIN_KEY` | Admin key for "Start again" on `/demo`, sent as the `x-demo-admin-key` header. Unset: reset is open in memory and turned off with a database |
| `DEMO_SENDER_V01`..`V06` | Demo only: extra registered sender addresses per vendor (comma-separated), so a tester's own emails pass the sender check |

Model choice (measured 22 Oct 2026): on the free tier `gemini-3.8-flash` allows 20 requests a day and returned
"high demand" errors on about half of the calls; `gemini-3.5-flash-lite` read the live-tested invoices with zero field
differences in 2-3 s per read and has a much larger daily allowance. Reports: `reports/live-extraction-<model>.json`,
`reports/live-golden-<model>.json`.

Time limits: Vercel stops a function after 300 s. The reader starts no new call after 120 s and the line matcher after
45 s, so a run always ends decided or FAILED (retryable) inside that limit; a run still processing after 6 minutes is
marked FAILED by a sweep.

## Tests

```powershell
npm test            # domain, golden run (18 scenarios), state machine, extractor (MOCK provider), intake, UI formatting
npm run test:pg     # the whole suite on PostgreSQL (TEST_DATABASE_URL in .env.test.local, a TEST database only)
npm run test:live   # real Gemini calls on S1, S7, S14 (GEMINI_* in .env.local); writes reports/live-extraction-<model>.json
npm run test:live:golden   # all 18 test invoices read by the real model (about 21 calls); reports/live-golden-<model>.json
npm run typecheck; npm run lint; npm run build
```

Browser checks (real clicks in Chromium, results checked through the API) are in `scripts/ui-check`. Its README
says how to run them against a local server; they refuse to run against a database or a real AI reader.

The golden run feeds every recorded email through the same intake adapter the app uses and applies the test
matrix pass rule; it must also agree with the independent oracle (`oracle_results.json`).

## Architecture

| Layer | Where | Notes |
|---|---|---|
| Rules, states, actions | `src/domain` | Pure TypeScript; no framework, database or network imports |
| Store | `src/domain/runs/memory-store.ts`, `src/server/db/pg-store.ts` | Same contract; writes serialised by a Postgres advisory lock per schema; decisions re-checked at commit (T16); few round trips per transaction |
| AI | `src/server/extractor` | Versioned prompts, schema validation, retries with a backup model and a time budget, cache by file hash + prompt + model |
| Intake | `src/server/email-intake.ts`, `src/app/api/inbound/resend` | One run per attachment; repeats ignored; fetch failures recorded |
| Outgoing email | `src/server/correction-email.ts` | Check, send (idempotency key), then record; a failed send changes nothing |
| App | `src/app`, `src/ui` | Next.js. The desk (what needs a decision, what is safe to approve, what is ready to export, with counts and sums from the records), the review screen (each hold with its risk, figures and safe next step; the invoice against its PO; every check, with the measured reading and checking time; the document; the history; every action in a dialog that says what it does), the rules page and the demo inbox. The desk shows when each invoice is due (per terms); the whole audit log downloads as CSV (`/api/audit`). Icons: lucide-react; font: IBM Plex Sans |

## Path to production

What I would change before real invoices and real money go through it, in order:

1. **Logins and roles.** Single sign-on, with roles for AP clerk, AP lead and finance. Maker-checker: whoever
   uploaded an invoice or requested its correction cannot also approve it, and every override needs a second
   person. Above the approval limit (Rs 2,00,000, C5) a second, named approver signs off. Today anyone can override
   with a note.
2. **The AI provider.** Use a paid Gemini tier, whose terms keep prompts out of product training, or Vertex AI in
   the Mumbai region (asia-south1) so documents stay in India.
   - The reader sits behind one interface (`Extractor` in `src/domain/runs/pipeline.ts`), so another model,
     including a self-hosted one, replaces one file.
   - Before switching, `npm run test:live:golden` must pass with that model.
   - On real invoices, track how often each field is corrected by reviewers.
3. **Email.** A verified sending domain (SPF, DKIM) so correction emails reach any vendor, not only the Resend
   account's own mailbox.
4. **Vendor master and POs from the ERP**, in place of the CSV files:
   - PO validity dates and status
   - goods receipts, for a three-way match
   - bank changes made only in the ERP
5. **Database access.** Each request loads only the invoices it needs (indexed queries, a paged list) instead of every
   run, and writes lock per PO and vendor rather than one write at a time.
6. **Work queues.**
   - Daily alerts for invoices close to their due date (the desk shows due dates today, but sends nothing).
   - Reminders to vendors who have not answered a correction.
   - A note to the sender when a file is skipped as not an invoice.
7. **Undo.** Undoing an approval until the invoice is exported (decided and deferred, Q10).
8. **Tax.** TDS deduction; IGST against CGST and SGST by place of supply; GSTIN format and checksum; the buyer GSTIN
   printed on the invoice.
9. **Payment runs and audit.**
   - Choose which approved invoices go on a payment run, in the bank's or the ERP's file format (today every approved
     invoice goes).
   - A filtered audit export by date, vendor and person (today one CSV of every event).
10. **Operations.** Error alerts, the cost per invoice, a retention policy for documents, and backups.

## Assumptions and limitations

- Text-layer evidence only: scans and photos with no text layer are always held for a human check (SCAN_UNVERIFIED).
  That includes handwritten invoices; how well the model reads handwriting has not been measured. On a scan there is
  no text to search for bank wording, so when no account is read the review screen says so and the reviewer checks
  the image against the vendor master.
  A scanned PDF that already carries an OCR text layer is treated like a digital PDF, and its values are checked
  against that text.
- PDF limits: at most 50 pages and 200,000 characters of text, read within 15 s (opening the file included); a
  larger or slower file is recorded as unsupported rather than read in part.
  Attachments the email provider reports as over 4 MB are not downloaded.
- INR only. GST is checked for arithmetic consistency, not for tax law: IGST against CGST and SGST, the GSTIN format
  and the buyer GSTIN on the invoice are not checked, and TDS is not handled. Unit conversions only through the catalog.
- PO dates and validity are not checked: an open PO matches whatever its date.
- Lump-sum lines are recognised only by explicit markers and always held. Credit notes and discounts are not processed.
- Charge wording outside the keyword list ends as LINE_UNMAPPED (still held).
- Disputes against an exported invoice need the company's credit-note process: the new invoice can only be held or rejected.
- Reviewer identity is a self-selected display name, recorded but unverified. Anyone with the link can upload and
  approve; production needs authenticated staff and role checks.
- Uploads are trusted as internal actions (no sender check).
- V3 is a presence check: it catches values the document does not contain, not a misread that matches another value on the page.
  Amounts must appear as the same whole number (a misread 1300.00 is not vouched for by a printed 13,000.00).
  The invoice date must appear as the same day (V3c).
  - Numeric dates are read day first, as Indian invoices print them. A vendor that prints the month first
    (10/12/2026 for 12 October) is held, and a reviewer checks the date.
  - A date read from elsewhere on the page, such as the due date, is vouched for, like any other V3 value.
- Line matching by description (M1) accepts an invoice line that contains every word of the PO line, so "Food
  container lid 500 ml" matches "Food container 500 ml". AI-proposed matches are held to a stricter rule (two item
  words in common, including the word that names the item); the deterministic M1 match is not.
- Duplicate checks work on the vendor and invoice number. A re-scan whose vendor was misread is caught when it has the
  same total and the same number or date as a payable copy (it is held, or approving it needs a second confirmation);
  a copy whose vendor, number and date were all misread is not linked to the original unless it is the same file.
- A vendor's reply to a correction request for an invoice that could not be read arrives as a new invoice; the
  original is then rejected by hand.
- Overriding a bank, vendor, GSTIN or sender hold needs a recorded call to the vendor-master number. The call time has
  no earliest limit, because a vendor may call about a bank change before sending the invoice.
- "Paid" is never shown: payment happens in finance's own process after export.
- Due dates on the desk are display only. For an invoice not cleared yet, the due date is its invoice date plus the
  vendor's terms. Nothing is sent or escalated when a date is near.
- An approval cannot be undone. A mistaken one goes out on the next payment list, and finance has to stop it in
  their own process; undo before export is deferred (Q10).
- Export takes every approved invoice that is not blocked. The audit log is one CSV of every event, with no filters.
- When a file is skipped (not an invoice, unsupported, no attachment), the sender is not told automatically.
- Each request loads every run from the database, and writes are serialised one at a time. That is fine for a demo,
  but not for thousands of invoices (see Path to production).
- Timings are measured on the server around each step of the last processing. Runs processed before timings were
  added show none.
- Accuracy figures describe this synthetic test set only (18 invoices, 17 digital and 1 scan); real-world reading
  accuracy has not been measured. An invoice from a vendor not in the master, such as one a tester makes, is held as
  VENDOR_UNKNOWN, which is the intended check. Free-tier AI content may be used by the provider: use fictional data
  only.
- Correction emails are written by code and sent through Resend. Without a verified domain, Resend's test sender only
  delivers to the Resend account's own address; for any other vendor address the send is refused, nothing changes,
  and the reviewer can copy the text and mark it sent manually.
- Free-tier AI quotas are small (see Model choice). Readings are cached by file, prompt and model and survive a demo
  reset, so replaying the same files costs no calls. To show a fresh AI reading, tick "Also forget saved readings"
  when resetting on the Demo inbox page.
- The `/demo` page simulates the email provider by replaying recorded test emails; intake and checks are the real ones.
- On a deployment with a database, "Start again" needs the `DEMO_ADMIN_KEY` admin key and is turned off without it.

## Secrets

Keys live only in `.env.local` / `.env.test.local` and the Vercel project settings (all git-ignored).
`.env.example` lists the variable names with placeholders.
