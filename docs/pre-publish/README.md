# Pre-Publish Review Packet

This directory contains the documents prepared for code review prior to
publishing the Warburg-oracle change set.

| File              | Purpose                                                          |
|-------------------|------------------------------------------------------------------|
| `REVIEW.md`       | Comprehensive review packet — scope, architecture, risk, evidence |
| `CHECKLIST.md`    | Go/no-go checklist with sign-off boxes                            |
| `CHANGES.diff`    | Raw `git diff` of the seven core source files (no codegen noise)  |

**Suggested reading order:** `REVIEW.md` → `CHANGES.diff` → `CHECKLIST.md`.

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
