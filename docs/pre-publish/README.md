# Pre-Publish Review Packet

This directory contains the documents prepared for code review prior to
publishing the Warburg-oracle change set.

| File                | Purpose                                                          |
|---------------------|------------------------------------------------------------------|
| `REVIEW.md`         | Revision 2 — resolves all 7 blockers from the rev-1 NO-GO        |
| `CHECKLIST.md`      | Go/no-go checklist with rev-1 blockers explicitly closed          |
| `CHANGES.diff`      | Raw `git diff` of hand-written source files (no codegen noise)    |
| `FOLLOWUPS.md`      | Tracker for rev-1 findings 8–12 (#8/#9 fixed inline, #10 partially mitigated, #11/#12 deferred to separate work streams) |
| `warburg.test.ts`   | Verbatim copy of the in-tree test suite (132 passing tests)       |

**Suggested reading order:** `REVIEW.md` → `warburg.test.ts` → `CHANGES.diff` → `FOLLOWUPS.md` → `CHECKLIST.md`.

To regenerate the diff against the pre-Warburg baseline:

```bash
git diff cbe413d..HEAD -- \
  artifacts/api-server/src/lib/warburg.ts \
  artifacts/api-server/src/lib/warburg-self-test.ts \
  artifacts/api-server/src/workers/editor.ts \
  artifacts/api-server/src/workers/verifier.ts \
  artifacts/api-server/src/routes/jobs.ts \
  artifacts/api-server/src/index.ts \
  artifacts/api-server/src/tests/warburg.test.ts \
  lib/db/src/schema/job-artifacts.ts \
  lib/db/src/schema/jobs.ts \
  lib/api-spec/openapi.yaml \
  README.md \
  > docs/pre-publish/CHANGES.diff
```
