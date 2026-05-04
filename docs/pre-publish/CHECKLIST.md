# Pre-Publish Go/No-Go Checklist

**Change set:** Warburg closed-form reference oracle
**HEAD:** `a83669c`

Mark each item before clicking Publish.

## Code quality

- [x] TypeScript compiles cleanly (`tsc --noEmit`)
- [x] All tests pass (132/132)
- [x] Architect code review verdict: PASS
- [x] No new lint suppressions, no `@ts-ignore`, no `any` introduced in core logic
- [x] No `console.log` or debug stubs left in worker paths

## Build & runtime

- [x] `pnpm build` succeeds (`dist/index.mjs` 2.5 mb)
- [x] Server boots and binds to `$PORT` (verified at 22:30:23)
- [x] No new runtime dependencies added (`package.json` unchanged in `dependencies`)
- [x] Source maps generated for production debug

## Contract & compatibility

- [x] OpenAPI regenerated and committed (`pnpm --filter @workspace/api-spec run codegen`)
- [x] All new fields on `PolicyConfig` and `NumericalArtifactPayload.diagnostics` are **optional + nullable**
- [x] Zod `policyConfigSchema` accepts but does not require new fields
- [x] Old API clients ignore the new diagnostic keys (JSON pass-through)

## Database

- [x] No DDL change required — new fields live inside existing JSON columns
- [x] No data backfill required
- [x] Existing rows remain readable by the new server

## Security

- [x] No new secrets, env vars, or external network endpoints
- [x] No new auth surface; oracle runs in the existing worker process
- [x] Math module is pure — no `eval`, no dynamic `require`, no FS or network I/O

## Documentation

- [x] `README.md` §8 check-catalogue table updated (CHK08, CHK10, CHK12)
- [x] `README.md` §8c "Warburg Closed-Form Oracle" added
- [x] `.local/.commit_message` describes the drift (CHK09/CHK11 removed)
- [x] Pre-publish review packet (this file + `REVIEW.md` + `CHANGES.diff`) committed

## Rollback

- [x] Last-known-good commit identified: `cbe413d`
- [x] Schema is forward-compatible — old binaries can read new rows
- [x] No data migration to undo

## Final gate

- [ ] Reviewer (Claude Code) verdict recorded
- [ ] Deployment type selected (Autoscale recommended)
- [ ] Publish initiated
