# CLAUDE.md: PS-1 invoice workflow (Zamp take-home)

You are the execution agent. The product spec and the plan are owned by the user's project mentor. Do only the phase the prompt asks for, then stop and report. Never start the next phase on your own.

## Source of truth, in this order
1. `planning/workflow-spec.md` v1.3: rules, states, codes. Section 16 (normalisation and rule order) and section 17 (audit decisions) are binding.
2. `planning/test-matrix.md` v1.3: tests and the pass rule.
3. `zamp-ps1-test-data-v2.1/test-data/answer_key.json` and `oracle_results.json`: golden expectations. `zamp-ps1-test-data-v2.1/scripts/validate_test_data.py` is an executable reference for stages 2-9 on the 18 scenarios. If it disagrees with the spec, the spec wins; report the difference, never pick silently.
4. `planning/implementation-plan.md` v2.4: what each phase includes.

If something is missing, ambiguous or contradictory, stop and ask in your report. Do not invent rules, codes or thresholds.

## Non-negotiables
- Business logic lives in `src/domain/` as pure TypeScript: no Next.js, Prisma, network or file-system imports. UI, API routes and scripts call into it.
- Money: integer paise for amounts; decimal.js for unit prices and quantities. Never use JavaScript number arithmetic on money.
- Reason codes exactly as spec sections 9-10. Never add or rename a code.
- AI never decides, never computes decision totals, never links corrections, never changes state.
- Never fake execution: no hard-coded results, no simulated success, no test reported as passing unless you ran it. Label every mock as a mock.
- Never commit secrets. `.env*` is git-ignored except `.env.example`, which holds placeholder names only.
- Do not modify `planning/` or `zamp-ps1-test-data-v2.1/` unless the prompt says so explicitly.
- The user is on Windows: commands and npm scripts must work in PowerShell, and paths must be cross-platform.
- Prefer the simplest reliable approach. Add a dependency only when it removes real work, and name it in your report with its version.

## Testing
- Vitest for TypeScript. Run the tests before reporting and paste the real summary lines.
- Pass rule (matrix): outcome equal, blocking codes exactly equal, every expected info code present (extras allowed), expected side effects observed.
- The golden run feeds every S and X test through the InboundEmail adapter with the recorded payloads and a mock extractor returning `expected_extraction`.

## Report at the end of every phase
1. What you built (files created or changed).
2. Commands you ran and their actual results (test counts, build, lint).
3. Each acceptance criterion: met or not met, with evidence.
4. Deviations from the spec or plan, and why.
5. Open questions for the mentor.

Then stop.
