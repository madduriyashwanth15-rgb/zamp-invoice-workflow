# Prompt for Claude Code (paste everything below the line)

---

Verify the overnight build on Windows and commit it. Do not change application code, tests or planning/ in this task.

Context: the mentor built phases C to F overnight in a Linux workspace and copied the files into this folder as
uncommitted changes. Read `reports/overnight-status.md` first. Your job is only to prove the same results on this
machine and commit.

Steps, in PowerShell, from the repo root:
1. `git status` and `git log --oneline -3`. Expect HEAD at "Phase B: foundation" with many uncommitted files.
2. `npm install` (package.json already lists the new packages: pg 8.23.1, @types/pg 8.23.1, unpdf 1.8.1,
   @fontsource-variable/atkinson-hyperlegible-next 5.3.0; this updates package-lock.json).
3. `npx next typegen`
4. `npm run typecheck`
5. `npm run lint`
6. `npm test`. Expected: `Tests 222 passed | 4 skipped (226)` (the 4 skipped need TEST_DATABASE_URL).
7. `npm run build`
8. `npm run test:live`. Expected now: all 4 skipped (no Gemini key yet). Do not add a key.

Rules:
- If any step fails, stop. Do not edit code or tests to make it pass. Report the exact command and the full error
  output, and whether it looks Windows-specific (paths, line endings, file locks).
- If every step passes: `git add -A`, check with `git status` that no `.env.local`, `.env.test.local` or other
  secret file is staged, then commit with the message
  "Overnight build: rule engine, state machine, Postgres store, extractor, app (verified on Windows)".
  Include AGENTS.md if `next dev` re-created it. Do not push.
- Do not run the Python validator in this task.

Report in the CLAUDE.md format: each command with its real summary lines, the commit hash (or the failure), and
anything unexpected. Then stop.
