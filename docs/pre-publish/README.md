# Pre-Publish Review Packet

This directory contains the documents prepared for code review prior to
publishing the Warburg-oracle change set.

| File                | Purpose                                                          |
|---------------------|------------------------------------------------------------------|
| `REVIEW.md`         | Revision 2 — resolves all 7 blockers from the rev-1 NO-GO        |
| `CHECKLIST.md`      | Go/no-go checklist with rev-1 blockers explicitly closed          |
| `CHANGES.diff`      | Raw `git diff` of hand-written source files (no codegen noise)    |
| `warburg.test.ts`   | Verbatim copy of the in-tree test suite (132 passing tests)       |

**Suggested reading order:** `REVIEW.md` → `warburg.test.ts` → `CHANGES.diff` → `CHECKLIST.md`.

To regenerate the diff against the pre-Warburg baseline:

```bash
git diff cbe413d..HEAD -- \
  artifacts/api-server/src/lib/warburg.ts \
  artifacts/api-server/src/workers/editor.ts \
  artifacts/api-server/src/workers/verifier.ts \
  artifacts/api-server/src/routes/jobs.ts \
  lib/db/src/schema/job-artifacts.ts \
  lib/db/src/schema/jobs.ts \
  lib/api-spec/openapi.yaml \
  > docs/pre-publish/CHANGES.diff
```
