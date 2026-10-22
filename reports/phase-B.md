# Phase A and Phase B report (22 Oct 2026)

Phase A and Phase B are both done. All five docs match the expected hashes, everything passes, and there are two commits on `main`: `28a46d3` (baseline) and `e29c004` (Phase B: foundation). Running the validator overwrote two test-data files; they were restored from the original zip.

## Phase A: docs sync

| File | Before | After | Edits |
|---|---|---|---|
| `planning/workflow-spec.md` | `d238876e9258d157ab64c38b969ca110ddb548465442bd326bd7a87d1fb9b6e7` MATCH | `695fe285f2714d229510a6337bd40f4158a467b94febe1f8f635c9c72597f4d9` MATCH | 26/26 |
| `planning/test-matrix.md` | `e296b209bbb27e253d306288b8caf10c66a2c49964c2cc2ab5171970ccca9746` MATCH | `cf1992236aa6dbded5ac4fa6bb8f284d869abbca52eeb0b032036049773c46cd` MATCH | 9/9 |
| `planning/SOLUTION_REVIEW.md` | `4953fe27dd76930de1fd9722cb8c48302ec4cace1c4f6cad366a974209913948` MATCH | `ca3a625a756bc8835ba7cf229531103d84d1efde6478f85fa08be3a6f8245c50` MATCH | 7/7 |
| `planning/implementation-plan.md` | (not given) | `f460ec614287cd365a0c0758a4ab911942af61ad4caa3d2ab7de6f5d65ae24e1` MATCH | full replacement |
| `CLAUDE.md` | (new) | `8694968badc5c9954d4431ba7231c89610c726b93991a9d585e1e2b074ab31a3` MATCH | full replacement |

Every FIND occurred exactly once; nothing was left unapplied. All files stayed LF, as they were. The plan was briefly written with CRLF because of a faulty line-ending check, then put back to LF before committing.

## Phase B: foundation

### 1. What was built
- **Scaffold:** Next.js App Router with TypeScript, Tailwind, ESLint and a `src/` folder. The page shows one line: "PS-1 invoice workflow: build in progress".
- **`src/domain/`**, pure TypeScript:
  - `money.ts`: amounts are integer paise stored as `bigint`, so no JavaScript number arithmetic touches money. It has `toPaise`, `lineAmountPaise` (rounds half-up), `withinOneRupee` and `c1Compare` (cross-multiplication, spec 16.4).
  - `normalise.ts`: invoice-number, PO-reference, token, unit and text normalisers, ported from the oracle.
  - `detect.ts`: `isChargeLine` and `isLumpSum`, which read their keyword and marker lists from settings.
  - `codes.ts`: every reason code with its kind and priority, the section 9 severity order, and the three event codes.
  - `types.ts` and `extraction-schema.ts`: a zod schema that rejects a `vendor_gstin` equal to the buyer's GSTIN.
- **`src/fixtures/load.ts`**: a small quote-aware CSV parser, reference-data loader (vendors, catalog, POs with their lines, settings), answer key loader, and email loader that fills in `{{TOKEN:id}}` and throws if a token is missing.
- **Tests:** `tests/domain.test.ts` and `tests/fixtures.test.ts`, with `vitest.config.mts`. The npm scripts are `dev`, `build`, `lint`, `test` and `typecheck`.

### 2. Commands and results
- `npm run test`: Test Files 2 passed (2), Tests 31 passed (31).
- `npm run lint`: exit 0.
- `npm run typecheck`: exit 0.
- `npm run build`: compiled successfully.
- Validator: `TOTAL: 264 checks, 263 passed, 0 failed, 1 skipped`. Tesseract is installed, but `pdftoppm` is missing, so the OCR sweep skipped.

### 3. Acceptance criteria: all met
- **Normalisers:** FP/2026/418 equals FP-2026-0418, 7731 equals PO-7731, stopwords are removed, "bottles" becomes "bottle", and "pcs" and "kg" are unchanged.
- **Money:** 2,000 x 3.045 = 609000 paise exactly. C1 against 3.00 gives 3.06 within, 3.0603 over, 2.94 within and 2.9399 below. The S13 inclusive prices 9.44 and 14.16 at 18% are within.
- **Detection:** the 9 lump-sum cases match the report's section 7. "Delivery charges" is a charge line; "FreshPack" and "Pack of 50" are not.
- **Codes:** every code in the answer key exists, and `AI_PROPOSAL_REJECTED` and `MANUAL_HOLD` are blocking.
- **Schema:** all 18 expected extractions parse, and S1 with the buyer's GSTIN as vendor is rejected.
- **Reference data:** 6 vendors and 10 POs with the matrix subtotals, and each PO's lines add up to its subtotal.
- **Domain purity:** `src/domain` imports only itself, decimal.js and zod.
- **Commits:** baseline first, then "Phase B: foundation".

### 4. Deviations
- **Validator rewrites test data:** it overwrites `validation_report.txt` and `oracle_results.json` on every run. The shipped report recorded a full OCR run (278/278); this run replaced it with 263 + 1 skipped. Both files were restored from `Downloads/zamp-ps1-test-data-v2.1.zip`, and all 51 files are byte-identical to the zip.
- **`.gitattributes` added** (not requested): Git's line-ending conversion (`core.autocrlf=true`) was treating the PDFs as text. The new file stores the test data byte-exact. The local, unpushed baseline commit was amended to include it.
- **`@types/node` raised from ^20 to ^24:** vitest 5 rejects ^20, and Node here is v24. `--force` was not used.
- **tsconfig target raised from ES2017 to ES2020:** needed for BigInt literals.
- **Vitest config named `.mts`:** this clears Vite's ESM warning.
- **Scaffold cleanup:** the boilerplate README was not copied and the unused `public/*.svg` were deleted. `AGENTS.md` was kept because `next dev` re-creates it.
- **Tests live in `tests/`:** this keeps file-system imports out of `src/domain`.
- **Schema nullability:** the fields that check V1 looks at (number, date, vendor, total) are nullable, so a missing field becomes a `MISSING_REQUIRED_FIELD` hold rather than a schema failure.
- **Field naming:** domain fields keep the data files' snake_case names.

### 5. Open questions for the mentor
1. `doc_type` has no defined list of values; for example, what value does a credit note use for G3? For now it is any non-empty string.
2. Spec 16.4 mentions IGST, but the extraction shape has no `igst` field.
3. Spec 16.4 fixes C1 at 102/98, so the `price_tolerance_pct` setting isn't used. Should the setting drive C1?
4. `approval_limit_inr` is a JSON number in settings. The plan is to convert it to paise in Phase C; please confirm.
5. `registered_senders` is assumed to use "|" as its separator, like `aliases`. The data only has one sender per vendor.
6. How should the validator be run in future without modifying test data? For example, restore from git after each run.

## Dependencies
- Runtime: next 16.4.2, react 19.3.0, react-dom 19.3.0, decimal.js 10.6.0, zod 4.6.7.
- Dev: vitest 5.0.5, typescript 5.9.3, eslint 9.39.5, eslint-config-next 16.4.2, tailwindcss 4.3.3, @tailwindcss/turbopack 4.3.3, @types/node 24.19.2.
- Python (validator): pdfplumber 0.11.10, pypdf 6.21.2, reportlab 5.0.1, pillow 13.0.0.

## Things to know
- **Other Python projects:** `pip install` pulled pillow 13.0.0 into the global Python, and the installed streamlit 1.37.1 needs pillow below 11. That may break streamlit outside this project.
- **Git identity:** it's set for this repo only, as madduriyashwanth15-rgb <madduriyashwanth15@gmail.com>. The global git config is unchanged.
- **Not checked:** npm left one dependency's install script (`unrs-resolver`) unapproved. Lint still passes, but what that script does was not examined.
