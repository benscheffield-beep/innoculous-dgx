# Pre-Publish Go/No-Go Checklist — Revision 2

**Change set:** Warburg closed-form reference oracle
**Working tree on top of:** `a83669c`
**Previous verdict:** NO-GO. All seven items resolved.

## Resolution of rev-1 blockers

- [x] **#1** CHK10 dead code → `chk10WarburgIntegrability` removed from `verifier.ts`
- [x] **#2** OpenAPI CHK09 reference → `warburg_kernel_cutoff_tol` removed from `openapi.yaml`
- [x] **#3** Mercer-slope per-job-constant → `chk12MercerSlope` removed; mercer now validated at boot
- [x] **#4** s=(d+1)/2 vs s=1 docstring contradiction → `warburg.ts` header rewritten
- [x] **#5** Dead diagnostic `kernel_cutoff_value` → removed from schema + editor
- [x] **#6** Dead policy field `warburg_kernel_cutoff_tol` → removed end-to-end + codegen regenerated
- [x] **#7** Phase validators wired in → `assertWarburgSelfTest(logger)` invoked in `index.ts`
- [x] **bonus** Test file supplied → `docs/pre-publish/warburg.test.ts` (verbatim copy of in-tree)

## Code quality

- [x] TypeScript compiles cleanly (`tsc --noEmit` for api-server, `tsc --build` for libs)
- [x] All tests pass (132/132)
- [x] No new lint suppressions, no `@ts-ignore`, no `any` introduced in core logic
- [x] No `console.log` or debug stubs left in worker paths
- [x] Dead-code sweep returns no production references to removed names

## Build & runtime

- [x] `pnpm build` succeeds (`dist/index.mjs` 2.5 mb, 260 ms)
- [x] Server boots and binds to `$PORT` (verified at 22:51:16)
- [x] **Startup self-test fires and passes at boot** (verified in workflow logs)
- [x] No new runtime dependencies added (`package.json` unchanged in `dependencies`)
- [x] Source maps generated for production debug

## Contract & compatibility

- [x] OpenAPI regenerated and committed (`pnpm --filter @workspace/api-spec run codegen`)
- [x] All remaining new fields on `PolicyConfig` and `NumericalArtifactPayload.diagnostics` are **optional + nullable**
- [x] Zod `policyConfigSchema` accepts but does not require new fields
- [x] Old API clients ignore the new diagnostic keys (JSON pass-through)
- [x] Removed fields (`warburg_kernel_cutoff_tol`, `mercer_slope_tol`, `mercer_slope`, `kernel_cutoff_value`) are absent from generated codegen

## Database

- [x] No DDL change required — all changes live inside existing JSON columns
- [x] No data backfill required
- [x] Existing rows remain readable by the new server (extra JSON keys are tolerated)

## Security

- [x] No new secrets, env vars, or external network endpoints
- [x] No new auth surface; oracle runs in the existing worker process
- [x] Math module is pure — no `eval`, no dynamic `require`, no FS or network I/O
- [x] Self-test runs synchronously at boot — no race with request handling

## Documentation

- [x] `README.md` §8 check-catalogue table reflects only CHK08
- [x] `README.md` §8c "Warburg Closed-Form Oracle" updated to describe self-test
- [x] Pre-publish review packet refreshed (`REVIEW.md`, `CHECKLIST.md`, `CHANGES.diff`, `warburg.test.ts`)

## Rollback

- [x] Last-known-good commit identified: `cbe413d` (pre-Warburg)
- [x] Schema is forward-compatible — old binaries can read new rows
- [x] No data migration to undo

## Final gate

- [ ] Reviewer (Claude Code) verdict recorded
- [ ] Deployment type selected (Autoscale recommended)
- [ ] Publish initiated
