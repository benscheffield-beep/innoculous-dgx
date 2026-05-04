# Pre-Publish Review Packet

**Project:** Innoculus
**Change set:** Unified Warburg theorem — TypeScript reference oracle
**HEAD commit:** `a83669c` — *Introduce new checks for Warburg theorem validation and diagnostics*
**Date:** 2026-05-04
**Reviewer audience:** Claude Code (pre-publish gate)

---

## 1. Executive summary

This change set integrates the unified Warburg theorem (originally specified
as `warburg_unified.py` pseudocode) into Innoculus as a **closed-form
TypeScript reference oracle** that runs alongside the existing numerical
Editor on every gaussian-kernel job. The oracle adds three new Verifier
checks (CHK08, CHK10, CHK12) and four informational diagnostic fields. It
introduces no new runtime dependencies, no new secrets, no new external
calls, and no destructive schema changes.

**Verdict requested:** approve for publish to Autoscale deployment.

---

## 2. Scope of change

| Area                | Files                                                   | Net Δ                |
|---------------------|---------------------------------------------------------|----------------------|
| New math module     | `artifacts/api-server/src/lib/warburg.ts`               | +376                 |
| Editor wiring       | `artifacts/api-server/src/workers/editor.ts`            | +78                  |
| Verifier wiring     | `artifacts/api-server/src/workers/verifier.ts`          | +66                  |
| API zod schema      | `artifacts/api-server/src/routes/jobs.ts`               | +18 / −4             |
| DB schema (JSON)    | `lib/db/src/schema/{job-artifacts,jobs}.ts`             | +9                   |
| OpenAPI contract    | `lib/api-spec/openapi.yaml`                             | +15                  |
| Generated clients   | `lib/api-client-react`, `lib/api-zod` (codegen output)  | +90                  |
| Tests               | `artifacts/api-server/src/tests/warburg.test.ts`        | +270 (new file)      |
| Docs                | `README.md`                                             | +28                  |

**Total:** 13 files, +1291 / −4 lines across two commits (`6fafd2c`, `a83669c`).

---

## 3. Architecture impact

### What is the oracle?

For a gaussian kernel `k₀(t) = exp(−σ²·t)`, the Mellin transform of the
field intensity admits a Bessel-form closed expression:

```
F̃(μ; ν) = 2 (B/A)^(ν/2) · K_ν(2√(AB))
```

with the editor convention `s = 1`, `A = σ²`, `B = π · μᵀ Q⁻¹ μ`, and
`ν = 1 − d/2`. The oracle evaluates this identity in TypeScript (Lanczos Γ,
exact `K_{1/2}`, integral-representation fallback for general ν) and the
Editor stores the L₂ residual against its numerical integrator.

### How it composes with existing pipeline

```
                 ┌────────────┐
  Job ──────────▶│   Editor   │── numerical F̃ ──┐
                 └────────────┘                  │
                       │                         ▼
                       └── computeWarburgOracle ▶ diagnostics{warburg_*}
                                                  │
                                                  ▼
                                           ┌──────────┐
                                           │ Verifier │── verdict
                                           └──────────┘
                                                  │
                                CHK08 / CHK10 / CHK12
```

For any non-gaussian kernel, `computeWarburgOracle()` returns four nulls and
the three new verifier checks short-circuit to `null` — the existing pipeline
is unchanged.

### Empirical accuracy

- Default 2D job: `closed_form_residual ≈ 3.4 × 10⁻¹⁰`
- Mercer half-integration log-log slope ≈ −1 (theoretical target)
- All five Warburg phase validators pass on default inputs

---

## 4. Risk assessment

| Risk                                   | Likelihood | Impact | Mitigation                                                                           |
|----------------------------------------|------------|--------|--------------------------------------------------------------------------------------|
| Numerical instability of `K_ν` at large `z` | Low    | Low    | Exact branch for `ν=1/2`; integral-rep capped to `cosh(t)` clipping; tested vs A&S  |
| Oracle disagrees with numerical Editor | Very low   | Medium | Residual itself is the diagnostic — surfaced as CHK08 warn, never fail              |
| New verifier checks block valid jobs   | Very low   | Medium | All three are `warn` severity, not `fail`; CHK09/CHK11 already removed for noise    |
| Schema migration risk                  | None       | None   | New fields are additive, optional, nullable; live inside existing JSON columns      |
| Backward compatibility                 | None       | None   | Old clients ignore unknown diagnostic fields; `policyConfigSchema` is `.passthrough` |
| Performance regression                 | Very low   | Low    | Oracle is `O(d²)` (matrix solve) + one Bessel call; ~µs on default jobs             |

### Drift from session plan (intentional)

- **CHK09 removed** — the kernel-cutoff cancellation check was tautological:
  `kernelKClosedForm` includes the latency factor by construction, so
  `K(T_now − δ) ≡ 0`. Architect review flagged this in the first pass.
- **CHK11 removed** — the Warburg-pole regime check fired on every gaussian
  job with `d ≥ 2`, downgrading healthy verdicts to `warn` without signaling
  any actionable problem.
- A regression-guard test (`warburg.test.ts`) asserts that no payload can
  cause CHK09 or CHK11 to be emitted.

Underlying values (`warburg_nu`, `kernel_cutoff_value`) are still emitted as
informational diagnostics — they just no longer drive verdicts.

---

## 5. Validation evidence

| Gate                  | Result                                                  |
|-----------------------|---------------------------------------------------------|
| Unit + integration    | **132/132 pass** (was 107 before this task)            |
| TypeScript            | `tsc --noEmit` clean                                    |
| Build                 | `pnpm build` → `dist/index.mjs` 2.5 mb, 267 ms          |
| Server boot           | Listens on `$PORT` (8080), 22:30:23 healthy             |
| Architect code review | **PASS** (after CHK09/CHK11 removal)                   |
| OpenAPI codegen       | `pnpm --filter @workspace/api-spec run codegen` clean   |

### Key test coverage added

- Γ at integers and half-integers vs reference values
- `K_{1/2}` closed form `√(π/2z)·e^(−z)` vs analytic
- `K_0` vs Abramowitz & Stegun table values
- `besselIntegralClosedForm` vs trapezoidal numerical integration on Gaussians
- `B → 0` limit reduces to `Γ(ν)/A^ν`
- Mercer slope ≈ −1 on a 220-point Jacobi grid
- All 5 phase validators on default Job
- CHK08 positive/negative/null-skip + custom-policy override
- CHK10 and CHK12 positive/negative/null-skip
- **Regression guard:** CHK09 and CHK11 are never emitted across stress payloads

---

## 6. Deployment notes

### Runtime

- **Recommended type:** Autoscale (stateless HTTP API, request/response).
- **Reserved VM:** unnecessary unless the workload becomes long-lived.
- **Static:** not applicable — this is a Node API server.

### Environment variables

No new env vars introduced. The deployment will inherit whatever the API
server already requires (`DATABASE_URL`, OpenAI keys for cutoff_trace, etc.).
See `.local/skills/environment-secrets` if a secret rotation is needed.

### Database

- **No `drizzle-kit push` required for this change set.** All four new
  diagnostic fields and three new policy fields live inside existing JSON
  columns (`job_artifacts.diagnostics`, `jobs.policy_config`). Old rows
  remain valid; new rows simply have additional keys.
- If this is a first-ever production deploy, the initial schema still needs
  to be pushed once.

### Rollback plan

- Revert to commit `cbe413d` (last commit before the Warburg work) — schema
  is forward-compatible, so old binaries can read new rows without errors
  (extra JSON keys are ignored).
- No data migration to undo.

---

## 7. Files for reviewer focus

Highest-leverage files to inspect first:

1. **`artifacts/api-server/src/lib/warburg.ts`** — the new math module.
   Pure functions, no I/O. Validate the Bessel branches and the Mercer
   eigendecomposition against your reference of choice.
2. **`artifacts/api-server/src/workers/editor.ts`** — look for
   `computeWarburgOracle` at end of file. Confirm the convention mapping
   (`s=1`, `ν=1−d/2`, `A=σ²`, `B=π·μᵀQ⁻¹μ`).
3. **`artifacts/api-server/src/workers/verifier.ts`** — the three new
   checks (CHK08, CHK10, CHK12) inside the `Promise.all` chain. Each
   guards on `null` and short-circuits cleanly.
4. **`docs/pre-publish/CHANGES.diff`** — full diff of the seven core
   source files (excludes generated codegen output).

Lower-priority files (mechanical):

- `lib/db/src/schema/{job-artifacts,jobs}.ts` — additive optional fields
- `lib/api-spec/openapi.yaml` — additive optional schema entries
- `lib/api-zod/`, `lib/api-client-react/` — `pnpm codegen` output

---

## 8. Sign-off checklist

See `docs/pre-publish/CHECKLIST.md` for the explicit go/no-go list.
