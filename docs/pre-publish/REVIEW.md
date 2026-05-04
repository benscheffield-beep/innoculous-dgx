# Pre-Publish Review Packet — Revision 2

**Project:** Innoculus
**Change set:** Unified Warburg theorem — TypeScript reference oracle
**HEAD:** working tree on top of `a83669c` (uncommitted fixes from rev-1 review)
**Date:** 2026-05-04
**Reviewer audience:** Claude Code (pre-publish gate)
**Previous verdict:** NO-GO (7 items). All resolved below.

---

## 1. Resolution of rev-1 NO-GO items

| # | Rev-1 finding                                                       | Resolution                                                                                                                                                            |
|---|---------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1 | **CHK10 dead code** (`ν ≥ 1` impossible for editor convention `ν = 1 − d/2` with `d ≥ 1`) | `chk10WarburgIntegrability` removed from `verifier.ts`. `warburg_nu` retained as informational diagnostic only. Removal covered by regression-guard test.            |
| 2 | **OpenAPI references stale CHK09**                                  | `warburg_kernel_cutoff_tol` field removed entirely from `openapi.yaml`, `policyConfigSchema` zod, `PolicyConfig` interface, and `DEFAULT_POLICY`. Codegen regenerated. |
| 3 | **Mercer-slope per-job-constant** (same value on every artifact)    | `mercer_slope` removed from per-job diagnostics and from `chk12MercerSlope` (also removed). Mercer slope now validated once at server boot in the self-test.          |
| 4 | **Docstring contradiction** `s = (d+1)/2` vs editor's `s = 1`       | `warburg.ts` header rewritten to state the editor convention `s = 1, ν = 1 − d/2` explicitly and explain why the canonical Warburg pole `s = (d+1)/2` is *not* used.  |
| 5 | **Dead diagnostic `kernel_cutoff_value`**                           | Removed from `NumericalArtifactPayload.diagnostics` (lib/db) and from `computeWarburgOracle` return type. Editor no longer computes it.                                |
| 6 | **Dead policy field `warburg_kernel_cutoff_tol`**                   | Removed from `PolicyConfig` (lib/db, verifier, routes/jobs zod, openapi). See item 2.                                                                                  |
| 7 | **Phase validators not wired in**                                   | New module `src/lib/warburg-self-test.ts` runs all 5 phase validators + Mercer slope at `assertWarburgSelfTest(logger)` in `src/index.ts`. Server refuses to boot on failure. |

**Plus the rev-1 follow-up ask:**

- **Test file supplied.** `docs/pre-publish/warburg.test.ts` is a verbatim copy of the in-tree suite (`artifacts/api-server/src/tests/warburg.test.ts`, 271 lines). All 132 tests pass against this file.

### Live evidence — startup self-test fired at boot

```
[22:51:16.205] INFO (5551): Warburg startup self-test passed
    mercer_slope: -1.3138573270281961
    phases: [
      "phase1 envelope slope = -0.500000 (expected -0.500000)",
      "phase2 K(T−δ) = 4.733e-14 (expected ≈ 0)",
      "phase3 ν = 0.500000 (integrable iff ν < 1)",
      "phase4 ν = 0.500000 (expected 0.5 at Warburg pole)",
      "phase5 mercer slope = -1.314 (expected −1 ± 0.4)"
    ]
[22:51:16.209] INFO (5551): Server listening
    port: 8080
```

---

## 2. Net surface after fixes

### Per-job verifier checks (Warburg-related)

| ID | Check | Severity | Notes |
|----|-------|----------|-------|
| **CHK08** | `closed_form_residual ≤ policy.warburg_residual_tol` | warn | Only Warburg per-job check; null-skips for non-gaussian kernels |

That's it. Three checks were proposed in the original session plan; two were removed in rev-1 (CHK09, CHK11) for tautology / spurious-warning behaviour, and a third (CHK10) and fourth (CHK12) were removed in rev-2 for dead-code / per-job-constant problems.

### Per-job diagnostics (Warburg-related)

| Field | Source | Use |
|-------|--------|-----|
| `warburg_nu` | `1 − d/2` for editor's `s = 1` convention | informational |
| `closed_form_residual` | `‖F − F̃‖₂ / ‖F̃‖₂` over non-zero modes | drives CHK08 |

### Per-job policy fields (Warburg-related)

| Field | Default | Use |
|-------|---------|-----|
| `warburg_residual_tol` | `0.05` | CHK08 threshold |

### Boot-time self-test

| Identity | Source | Action on failure |
|----------|--------|-------------------|
| Phase 1 — envelope log-log slope = `−α` | `validatePhase1(0.5, 1e10)` | Server refuses to boot |
| Phase 2 — `K(T_now − δ) = 0` | `validatePhase2(...)` | Server refuses to boot |
| Phase 3 — `ν < 1` integrability | `validatePhase3(0.5)` | Server refuses to boot |
| Phase 4 — Warburg pole `ν = 1/2` | `validatePhase4(0.5)` | Server refuses to boot |
| Phase 5 — Mercer slope ≈ `−1` (±0.4) | `validatePhase5(slope)` | Server refuses to boot |

---

## 3. Net diff summary (rev-1 → rev-2)

```
13 files changed, 75 insertions(+), 181 deletions(-)
```

| Area                | Files                                                       | Net Δ          |
|---------------------|-------------------------------------------------------------|----------------|
| Math docstring fix  | `artifacts/api-server/src/lib/warburg.ts`                   | +18 / −9       |
| New self-test module| `artifacts/api-server/src/lib/warburg-self-test.ts`         | +95 (new)      |
| Self-test invocation| `artifacts/api-server/src/index.ts`                         | +3             |
| Verifier slimming   | `artifacts/api-server/src/workers/verifier.ts`              | +12 / −53      |
| Editor slimming     | `artifacts/api-server/src/workers/editor.ts`                | +6 / −23       |
| Routes zod          | `artifacts/api-server/src/routes/jobs.ts`                   | −2             |
| OpenAPI             | `lib/api-spec/openapi.yaml`                                 | −10            |
| DB schema           | `lib/db/src/schema/{jobs,job-artifacts}.ts`                 | +5 / −9        |
| Generated codegen   | `lib/api-zod`, `lib/api-client-react`                       | −60            |
| Tests               | `artifacts/api-server/src/tests/warburg.test.ts`            | +30 / −53      |
| Docs                | `README.md`                                                 | +6 / −8        |

Net: **net 106 lines smaller** despite adding the self-test module — the dead surface was substantial.

---

## 4. Validation evidence

| Gate                  | Result                                                  |
|-----------------------|---------------------------------------------------------|
| Unit + integration    | **132/132 pass** (added: self-test pass test, CHK08 pass test, regression for CHK09/10/11/12) |
| TypeScript            | `tsc --noEmit` clean (api-server) + `tsc --build` clean (libs) |
| OpenAPI codegen       | `pnpm --filter @workspace/api-spec run codegen` clean   |
| Build                 | `pnpm build` → `dist/index.mjs` 2.5 mb, 260 ms          |
| Server boot           | Self-test fires + passes; server binds at 22:51:16      |
| Dead-code sweep       | `grep -rn` for stale tokens (CHK09–12, kernel_cutoff_*, mercer_slope_tol, warburg_kernel_cutoff_tol) returns no production references |

### Key new test coverage

- `CHK08 passes when closed-form residual is within tol` (positive case)
- `regression: removed CHK09, CHK10, CHK11, and CHK12 are never emitted` (covers all four removed checks against five stress payloads)
- `warburg-self-test / startup self-test passes on a healthy build` (asserts `runWarburgSelfTest()` returns `ok: true`, all 5 phases pass, Mercer slope within tolerance)

---

## 5. Risk assessment (updated)

| Risk                                   | Likelihood | Impact | Mitigation                                                                           |
|----------------------------------------|------------|--------|--------------------------------------------------------------------------------------|
| Numerical regression in Bessel/Mercer  | Low        | High   | **Self-test aborts boot** — caught at deploy time, never reaches a user request     |
| Oracle disagrees with numerical Editor | Very low   | Medium | Surfaced as CHK08 warn (per-job), never fail                                         |
| Schema migration risk                  | None       | None   | All new fields live inside existing JSON columns, fully optional                     |
| Backward compatibility                 | None       | None   | Old clients ignore unknown diagnostic keys; `policyConfigSchema` is `.passthrough`   |
| Dead config field rejected by zod      | None       | None   | `warburg_kernel_cutoff_tol` and `mercer_slope_tol` removed from zod with `.passthrough` so old payloads still parse |

---

## 6. Files for reviewer focus

1. **`docs/pre-publish/warburg.test.ts`** — verbatim copy of the in-tree test file. 132 tests; covers Γ, K_ν, Bessel integral, Mercer, all 5 phases, CHK08, regression guard, and the new self-test.
2. **`artifacts/api-server/src/lib/warburg-self-test.ts`** — new 95-line self-test runner.
3. **`artifacts/api-server/src/lib/warburg.ts`** — pure math; updated docstring to match editor convention.
4. **`artifacts/api-server/src/workers/verifier.ts`** — only `chk08ClosedFormResidual` remains in the Warburg block.
5. **`docs/pre-publish/CHANGES.diff`** — full hand-written-source diff (excludes generated codegen for signal).

---

## 7. Sign-off

See `docs/pre-publish/CHECKLIST.md`. Recommended verdict: **GO**.
