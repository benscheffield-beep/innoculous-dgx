# Innoculus — Deployment Reference & Verification Guide

**Audience:** This document is written for an AI code reviewer (Claude or equivalent) acting as a deployment verification overseer. Every section is intended to be read programmatically and reasoned over. Technical claims sourced from the current codebase are labeled **[current]**. Claims sourced from the three algorithm specification documents (Editor pseudocode, Verifier JSON spec, Manager PDR) but not yet implemented are labeled **[spec/planned]**. Shell examples use `$HOST` and `$JOB_ID` as substitution variables.

---

## Implementation Status (Snapshot)

The backend pipeline is implemented end-to-end and verified by automated tests. The frontend UI is the only major remaining piece.

| Subsystem | State | Evidence |
|---|---|---|
| Manager (REST gateway) | **Complete** | 9 endpoints in `artifacts/api-server/src/routes/jobs.ts` |
| Editor (12-step numerical pipeline) | **Complete** | `artifacts/api-server/src/workers/editor.ts` |
| Verifier (CHK01–CHK07 + HMAC) | **Complete** | `artifacts/api-server/src/workers/verifier.ts` |
| Pipeline orchestration with auto-retry + backoff | **Complete** | `artifacts/api-server/src/workers/pipeline.ts` |
| Remediation dispatching (warn/fail → adjusted descriptor → retry) | **Complete** | `applyRemediation()` in `pipeline.ts` |
| Database schema (jobs, job_artifacts, job_diagnostics) | **Complete and pushed** | `lib/db/src/schema/` |
| OpenAPI spec + generated client | **Complete** | `lib/api-spec/openapi.yaml`, `lib/api-client-react/src/generated/` |
| Test suite | **90 tests passing** | `math.test.ts` (18), `pipeline.test.ts` (17), `verifier.test.ts` (16), `jobs.test.ts` (39) |
| Frontend UI (User Mode + Developer Mode) | **Not started** | Tracked as follow-up task #7 |
| Persistent job queue (survives restarts) | **Not started** | Tracked as follow-up task #8 |

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [System Architecture](#2-system-architecture)
3. [Agent Roles and Responsibilities](#3-agent-roles-and-responsibilities)
4. [API Contract Summary](#4-api-contract-summary)
5. [Database Schema Overview](#5-database-schema-overview)
6. [Pipeline State Machine](#6-pipeline-state-machine)
7. [Editor Subagent — Numerical Pipeline](#7-editor-subagent--numerical-pipeline)
8. [Verifier Subagent — Check Catalogue](#8-verifier-subagent--check-catalogue)
9. [Policy Thresholds and Configuration](#9-policy-thresholds-and-configuration)
10. [Deployment Prerequisites](#10-deployment-prerequisites)
11. [Deployment Steps and Health Checks](#11-deployment-steps-and-health-checks)
12. [Known Limitations — v1 Scope](#12-known-limitations--v1-scope)
13. [Deployment Verification Checklist](#13-deployment-verification-checklist)

---

## 1. Project Overview

Innoculus is a full-stack application that exposes a multi-agent numerical computation pipeline to both non-technical users and technical developers. Its core pipeline implements a spectral self-force computation: a kernel-based absorber fixed-point solve followed by rigorous numerical verification, accessible through a dual-mode interface (simplified user view and full developer diagnostics view).

The pipeline is composed of three coordinated subagents:

- **Manager** — orchestrates job lifecycle, routes artifacts, enforces policy
- **Editor** — executes the numerical computation (kernel construction through spectral projection)
- **Verifier** — validates every artifact produced by the Editor against numerical and policy criteria before it is accepted

The application stack:

| Layer | Technology |
|---|---|
| Monorepo tool | pnpm workspaces |
| Runtime | Node.js 24 (per `replit.md`) |
| API framework | Express 5 |
| Database | PostgreSQL + Drizzle ORM |
| Validation | Zod v4, drizzle-zod |
| API codegen | Orval (from OpenAPI spec) |
| Build | esbuild → ESM bundle (`dist/index.mjs`) |
| Test runner | Vitest 3 + supertest |
| Frontend | React + Vite **[spec/planned]** — production UI not yet scaffolded. Note: `artifacts/mockup-sandbox` exists as a design/canvas prototyping sandbox and is not the production frontend. |

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────┐
│                   Client (Browser)               │
│  ┌──────────────┐        ┌─────────────────────┐ │
│  │   User Mode  │        │   Developer Mode     │ │
│  │ (simplified) │        │ (full diagnostics)   │ │
│  └──────┬───────┘        └──────────┬──────────┘ │
└─────────┼──────────────────────────┼─────────────┘
          │ HTTP                     │ HTTP
          ▼                          ▼
┌─────────────────────────────────────────────────┐
│              Express API Server (/api)           │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │              MANAGER SUBAGENT            │    │
│  │  • Job scheduling and state machine      │    │
│  │  • Artifact routing and versioning       │    │
│  │  • Policy enforcement middleware         │    │
│  │  • Observability (logs, metrics)         │    │
│  │  • REST gateway for Editor and Verifier  │    │
│  └──────┬─────────────────────┬────────────┘    │
│         │ dispatch             │ dispatch         │
│         ▼                     ▼                  │
│  ┌──────────────┐    ┌─────────────────────┐    │
│  │    EDITOR    │    │      VERIFIER        │    │
│  │   SUBAGENT   │    │      SUBAGENT        │    │
│  │  (numerical  │    │  (CHK01–CHK07        │    │
│  │   pipeline)  │    │   + signing)         │    │
│  └──────┬───────┘    └──────────┬──────────┘    │
│         │ artifact              │ verdict         │
│         └──────────┬────────────┘                │
│                    ▼                              │
│  ┌──────────────────────────────────────────┐    │
│  │          PostgreSQL (Drizzle ORM)        │    │
│  │  jobs | job_artifacts | job_diagnostics  │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

### Data Flow — Happy Path

1. Client submits `POST /api/jobs` with a job descriptor (kernel params, Q matrix, truncation, latency, precision config).
2. Manager creates a job record (`queued`), returns `job_id`.
3. Manager dispatches `POST /api/jobs/{id}/work` to the Editor.
4. Editor executes the 12-step numerical pipeline; on completion calls `PUT /api/jobs/{id}/artifact` + `PATCH /api/jobs/{id}/status`.
5. Manager transitions job to `verifying`, dispatches `POST /api/jobs/{id}/verify` to the Verifier.
6. Verifier runs CHK01–CHK07 in parallel; posts `POST /api/jobs/{id}/verdict`.
7. Manager applies verdict: `pass` → `complete`; `fail` → `failed` with remediation; `warn` → `complete_with_warnings`.
8. Client polls `GET /api/jobs/{id}` to read final state, diagnostics, and artifact.

---

## 3. Agent Roles and Responsibilities

### 3.1 Manager Subagent

**Source:** `attached_assets/Pasted-Product-Design-Requirements-for-Replit-Manager-Subagent_1777725624586.txt`

The Manager is the REST-compliant control plane. Its six primary responsibilities map directly to REST's six architectural constraints (see below).

| Responsibility | Description |
|---|---|
| Orchestration | Start/stop agents, route messages, manage retries with configurable backoff |
| State management | Persist intermediate artifacts and metadata with versioned immutable snapshots |
| Policy enforcement | Enforce truncation limits, privacy rules, and stability thresholds per-job |
| Observability | Collect logs, metrics, and health signals for every pipeline step |
| API gateway | Provide REST endpoints consumed by Editor and Verifier subagents |

**REST / Responsibility Synthesis (the Manager is the only agent where this applies):**

| REST Constraint | Manager Responsibility |
|---|---|
| Uniform Interface | API gateway — consistent endpoint contract for all agent interactions |
| Stateless | State management — request is self-contained; state lives in artifact store |
| Cacheable | Observability — immutable artifact snapshots are inherently cacheable |
| Client-Server | Orchestration — Editor/Verifier are clients; Manager is the authoritative server |
| Layered System | Policy enforcement — thresholds sit as middleware between Manager and agents |
| Code on Demand | Pluggable policy hooks — executable policy logic loaded and pushed at runtime |

**Nonfunctional targets:**

| Metric | Target |
|---|---|
| Orchestration decision latency | < 200 ms |
| Concurrent pipelines | ≥ 50 jobs |
| Control plane availability | 99.9% |

### 3.2 Editor Subagent

**Source:** `attached_assets/Pasted--Editor-Subagent-Pseudocode-Responsibilities-compute-du_1777725592876.txt`

The Editor is a pure numerical worker. It receives a job descriptor from the Manager, executes a deterministic 12-step pipeline, and uploads a signed artifact. It has no awareness of routing, policy, or verification.

**Inputs (from Manager via `POST /api/jobs/{id}/work`):**

| Field | Type | Description |
|---|---|---|
| `kernel` | object | Kernel type and parameters (Gaussian or Mellin) |
| `Q` | matrix | Lattice metric tensor |
| `truncation` | `{M, r}` | Dual truncation radius M; spectral rank r |
| `latency` | `{lambda, delta, Tnow}` | Latency envelope parameters |
| `precision` | `{b, tol}` | Register bit target b; solver tolerance tol |
| `model_pool` | array | Optional pool of spectral basis models |
| `job_id` | string | Unique job identifier |

**Outputs (uploaded to Manager via `PUT /api/jobs/{id}/artifact`):**

| Field | Description |
|---|---|
| `dual_indices` | Enumerated dual lattice vectors with `‖μ‖ ≤ M` |
| `F` | Sparse theta-function coefficients |
| `S` | Sparse Dirac-subtracted coefficients |
| `Phi_coeffs` | Spectral projection of absorber fixed-point solution |
| `R_coeffs` | Spectral projection of radiation reaction |
| `U_meta` | Spectral basis metadata (basis vectors U, eigenvalues λ) |
| `diagnostics` | `spectral_radius`, `cond_I_minus_G`, `dual_truncation_error`, `spectral_tail_error` |

### 3.3 Verifier Subagent

**Source:** `attached_assets/Pasted--name-verifier-subagent-version-1-0-purpose-Numerical-a_1777725602298.txt`

The Verifier is a validation oracle. It independently recomputes key numerics from the artifact, runs 7 parallel checks against configurable policy thresholds, and returns a signed verdict. It cannot modify artifacts — only approve, warn, or reject them.

**Access control:** `["manager", "auditor"]` only. No direct client access.

**Performance budget:** `max_runtime_seconds: 120`, with `parallel_checks: true`.

---

## 4. API Contract Summary

All routes are mounted under `/api`. The base OpenAPI spec lives at `lib/api-spec/openapi.yaml`. Client hooks are generated via Orval into `lib/api-client-react/src/generated/`.

### Currently Implemented **[current]**

#### Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/healthz` | Health check — returns `{ status: "ok" }` |

#### Job Management (Manager)

| Method | Path | Request Body | Response | Notes |
|---|---|---|---|---|
| `POST` | `/api/jobs` | `{ kernel, Q, truncation, latency, precision, model_pool?, policy_config?, job_id? }` | `{ job_id, status: "queued", created_at }` (201) | Idempotent with client-supplied `job_id` (returns 200 with existing job) |
| `GET` | `/api/jobs` | — | `{ jobs: Job[], total, page, page_size }` | Paginated; defaults to page=1, page_size=20 |
| `GET` | `/api/jobs/:id` | — | Full `Job` object with artifact ref and diagnostics | 404 if not found |
| `PATCH` | `/api/jobs/:id/status` | `{ status, step? }` | Updated `Job` | Editor → Manager status update |
| `PUT` | `/api/jobs/:id/artifact` | Signed artifact payload | `{ artifact_id, version }` | Immutable; creates new version |
| `POST` | `/api/jobs/:id/work` | `{ kernel, Q, truncation, seed? }` | `202 Accepted` | Manager → Editor dispatch |
| `POST` | `/api/jobs/:id/verify` | `{ artifact_id }` | `202 Accepted` | Manager → Verifier dispatch |
| `POST` | `/api/jobs/:id/verdict` | `{ verdict, issues, recomputed_metrics, signed_proof }` | `200 OK` with updated `Job` | Verifier → Manager result; sets final status |
| `POST` | `/api/jobs/:id/retry` | — | `{ job_id, status: "queued", retry_count }` | Re-enqueues a `failed` job (max 3 manual retries) |

#### Job Status Values

| Status | Meaning |
|---|---|
| `queued` | Job created, not yet dispatched to Editor |
| `editor_running` | Editor is executing the numerical pipeline |
| `verifying` | Editor complete; Verifier is running checks |
| `complete` | All checks passed |
| `complete_with_warnings` | Verifier issued `warn` verdict; job accepted with caveats |
| `failed` | Verifier issued `fail` verdict or Editor raised an exception |

---

## 5. Database Schema Overview

**ORM:** Drizzle ORM (`lib/db/src/schema/index.ts`)
**Database:** PostgreSQL

Schema is **implemented [current]** and pushed via `pnpm --filter @workspace/db run push`. The following tables are present in production:

### `jobs`

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | PK, default `gen_random_uuid()` | Unique job identifier |
| `status` | `text` | NOT NULL | One of the 6 pipeline status values |
| `kernel_params` | `jsonb` | NOT NULL | Full job descriptor as submitted |
| `policy_config` | `jsonb` | NOT NULL | Per-job policy thresholds |
| `current_artifact_id` | `uuid` | FK → `job_artifacts.id`, nullable | Points to latest accepted artifact |
| `created_at` | `timestamptz` | NOT NULL, default `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | Updated on every state transition |

### `job_artifacts`

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | PK | Artifact version identifier |
| `job_id` | `uuid` | FK → `jobs.id`, NOT NULL | Parent job |
| `version` | `integer` | NOT NULL | Monotonically increasing per job |
| `payload` | `jsonb` | NOT NULL | Full artifact: dual_indices, F, S, Phi_coeffs, R_coeffs, U_meta |
| `hash` | `text` | NOT NULL | SHA-256 of payload for integrity check (CHK01) |
| `signed_proof` | `text` | nullable | HMAC-SHA256 signature from Verifier |
| `created_at` | `timestamptz` | NOT NULL, default `now()` | Immutable after insert |

### `job_diagnostics`

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `job_id` | `uuid` | FK → `jobs.id`, NOT NULL | |
| `artifact_id` | `uuid` | FK → `job_artifacts.id`, NOT NULL | |
| `spectral_radius` | `float8` | NOT NULL | `ρ(G_off)` — must be < `policy.spectral_radius_max` |
| `cond_i_minus_g` | `float8` | NOT NULL | `κ(I − G_off)` — must be < `policy.cond_limit` |
| `dual_truncation_error` | `float8` | NOT NULL | Estimated error from truncating dual sum at M |
| `spectral_tail_error` | `float8` | NOT NULL | Estimated error from using only top-r modes |
| `verdict` | `text` | NOT NULL | `pass`, `warn`, or `fail` |
| `issues` | `jsonb` | NOT NULL | Array of `{ check_id, severity, message, remediation }` |
| `created_at` | `timestamptz` | NOT NULL, default `now()` | |

---

## 6. Pipeline State Machine

```
                   ┌──────────────────┐
    POST /api/jobs │      queued       │
  ─────────────── ▶│  job created,     │
                   │  awaiting dispatch│
                   └────────┬─────────┘
                            │ Manager dispatches
                            │ POST /jobs/{id}/work
                            ▼
                   ┌──────────────────┐
                   │  editor_running  │
                   │  Editor pipeline │
                   │  executing       │
                   └──┬───────────────┘
                      │                 │ exception /
                      │ PATCH status    │ timeout
                      │ PUT artifact    │
                      ▼                 ▼
                   ┌──────────────┐  ┌──────────┐
                   │  verifying   │  │  failed  │◀───────────────┐
                   │  Verifier    │  │          │                │
                   │  running     │  └──────────┘                │
                   └──┬──────────┘                               │
                      │ POST verdict                             │
          ┌───────────┼──────────────────┐                       │
          │           │                  │                       │
          ▼           ▼                  ▼                       │
   ┌──────────┐ ┌──────────────────┐ ┌──────────┐               │
   │ complete │ │complete_with_    │ │  failed  │───────────────┘
   │  (pass)  │ │warnings (warn)   │ │  (fail)  │  remediation:
   └──────────┘ └──────────────────┘ └──────────┘  reject + recompute
```

**Retry policy:** On `failed`, the Manager may re-dispatch to the Editor with adjusted parameters (damped `G_off`, reduced M, increased regulator epsilon) depending on which checks triggered the failure.

---

## 7. Editor Subagent — Numerical Pipeline

The Editor executes the following 12 steps deterministically for each job. Steps are sequential; no step may be skipped.

| Step | Operation | Key invariant |
|---|---|---|
| 1 | Load job parameters | All required fields must be present; abort if any are missing |
| 2 | Precompute base kernel `k0(t)` | Gaussian or Mellin; controlled by `kernel_params.type` |
| 3 | Build full latency-modulated kernel `K(t) = (1 − e^{−λ(t−T_now+δ)}) · k0(t)` | λ > 0, δ ≥ 0 required |
| 4 | Enumerate dual indices `‖μ‖ ≤ M`; compute `F(μ) = ∫₀^∞ K(t) t^{−d/2} exp(−π μᵀ Q⁻¹ μ / t) dt` | Q must be positive-definite |
| 5 | Regularize zero mode; compute short-time expansion coefficients `a_n` | |
| 6 | Build absorber coupling matrix `G_off` for truncated dual set | |
| 7 | Compute Dirac symmetric subtraction: `S_μ = lim_{ε→0}(F − F_sym)` | Limit must converge; divergence indicates regularization failure |
| 8 | Check `ρ(G_off) < 1 − safety_margin`; apply damping if violated; solve `Φ = (I − G_off)⁻¹ S` | **Critical stability gate** — damping must be applied before solve if threshold exceeded |
| 9 | Compute radiation reaction: `R = Φ − F_ret` | `F_ret` is the retarded (causal) part of F; causality enforced here |
| 10 | Project `Φ` and `R` onto top-r spectral modes from model pool | `r ≤ rank(U)`; truncation error estimated |
| 11 | Package artifact with all coefficients and diagnostics | Hash computed here; must match CHK01 hash at Verifier |
| 12 | Upload artifact to Manager; notify `editor_complete` | Upload must be acknowledged before step is marked complete |

**Key numerical constants:**

| Symbol | Role | Constraint |
|---|---|---|
| `M` | Dual truncation radius | Higher M → lower `dual_truncation_error`, higher compute cost |
| `r` | Spectral rank | Higher r → lower `spectral_tail_error`, higher memory |
| `tol` | Solver tolerance | Applies to both the Poisson integral and the linear system solve |
| `safety_margin` | Damping guard threshold | Default `1e-3`; `ρ(G_off) ≥ 1 − safety_margin` triggers damping |

---

## 8. Verifier Subagent — Check Catalogue

All 8 checks (CHK01–CHK08) run in parallel (`parallel_checks: true`). Maximum runtime budget: 120 seconds.

| ID | Name | Condition | Severity | Failure Action |
|---|---|---|---|---|
| CHK01 | `artifact_integrity` | `SHA-256(artifact.payload) == stored_hash` | **fail** | Reject artifact; request recompute |
| CHK02 | `spectral_radius_check` | `ρ(G_off) < policy.spectral_radius_max` | **fail** | Reject; apply damping to `G_off` |
| CHK03 | `condition_number_check` | `κ(I − G_off) < policy.cond_limit` | warn | Recommend increase of register bits `b` |
| CHK04 | `dual_truncation_error_check` | `dual_truncation_error ≤ policy.dual_error_tol` | warn | Recommend increasing truncation radius M |
| CHK05 | `spectral_tail_check` | `spectral_tail_estimate ≤ policy.spectral_tail_tol` | warn | Recommend increasing spectral rank `r` |
| CHK06 | `causality_check` | Retarded/advanced decomposition correct; `iε` prescription applied | **fail** | Reject; recompute with corrected prescription |
| CHK07 | `privacy_check` | No sensitive tokens or raw user data embedded in artifact payload | **fail** | Reject; sanitize and recompute |
| CHK08 | `closed_form_residual` | `‖F − F̃‖ / ‖F̃‖ ≤ policy.warburg_residual_tol` | warn | Recommend increase of register bits `b` |

CHK08 is populated by the closed-form Warburg oracle described in §8c. It no-ops (skip with no diagnostic) when the kernel falls outside the oracle's domain (e.g. non-gaussian). The companion quantity `warburg_nu` is stored as an informational diagnostic only — it is determined by construction (ν = 1 − d/2 for the editor's s = 1 convention) and has no associated check. The remaining theorem-level identities (Mercer eigenvalue slope and the five phase validators) depend only on fixed math constants, so they run as a one-shot startup self-test (`src/lib/warburg-self-test.ts`) that aborts boot on failure — they are not stored per-job.

**Verdict rules:**

- Any `fail` check → overall verdict `fail`
- All checks pass, one or more `warn` → overall verdict `warn`
- All checks pass → overall verdict `pass`

**Cryptographic signing:**

- Algorithm: HMAC-SHA256
- Key reference: `verifier_key_id` (resolved from environment/secrets store at runtime)
- Signed payload: canonical JSON of `{ artifact_hash, recomputed_metrics, verdict, timestamp }`
- Output field: `signed_proof` stored in `job_artifacts.signed_proof`

---

## 8b. Cutoff Trace Pipeline (LLM Knowledge-Cutoff Probing)

The `cutoff_trace` job kind reuses the same Manager / Editor / Verifier skeleton, retry/backoff loop, HMAC signing chain, and Drizzle schema as the numerical pipeline, but operates on a different problem domain: empirically estimating an LLM's knowledge cutoff month from user-supplied probes.

**Submission shape** (`POST /api/jobs`):

```json
{
  "kind": "cutoff_trace",
  "model": "gpt-4o-mini",
  "judge_model": "gpt-4o",
  "judge_temperature": 0,
  "probes": [
    { "question": "Who won the 2023 NBA Finals?", "answer": "Denver Nuggets", "date": "2023-06-12" },
    { "question": "...", "answer": "...", "date": "YYYY-MM-DD" }
  ]
}
```

**Editor steps** (`artifacts/api-server/src/workers/cutoff-editor.ts`):

| Step | Operation |
|---|---|
| 1 | For each probe, query `model` for an answer (system: "answer concisely; if unknown, say so") |
| 2 | Grade each answer with `judge_model` as LLM-as-judge → `{score: 0|1, reason}` |
| 3 | Aggregate by `YYYY-MM` → `monthly_aggregates[]` with per-month `knew_rate` |
| 4 | Fit a logistic changepoint `p(t) = σ((cutoff − t) · k)` over candidate cutoffs (half-month resolution) and slope grid `{0.5, 1, 2, 4}` by max log-likelihood |
| 5 | Derive 95% CI via likelihood-ratio profile (χ²₁ / 2 ≈ 1.92) and McFadden pseudo-R² as `fit_quality` |

OpenAI calls go through `artifacts/api-server/src/lib/openai-client.ts`, which routes to the Replit AI Integrations proxy (`AI_INTEGRATIONS_OPENAI_BASE_URL` / `AI_INTEGRATIONS_OPENAI_API_KEY`) and applies a small transient-error retry.

**Verifier checks** (`artifacts/api-server/src/workers/cutoff-verifier.ts`):

| ID | Name | Condition | Severity |
|---|---|---|---|
| CHK01 | `artifact_integrity` | recomputed `SHA-256(payload) == stored_hash` | **fail** |
| CT02 | `judge_agreement` | spot-recheck disagreement rate ≤ `judge_disagreement_max` (default 0.34); sample size = `max(min_recheck_count, ceil(n·0.1))`; deterministic seed = mulberry32(hash) | **fail** |
| CT03 | `monotonicity` | `knew_rate` should not jump up by >0.3 between consecutive post-cutoff months | warn |
| CT04 | `coverage` | every month bin has ≥ `min_probes_per_month` probes (default 2) | warn |
| CT05 | `privacy` | no email / phone / SSN PII patterns in probe text or model answers | **fail** |

**Diagnostics row mapping:** `dual_truncation_error` = judge disagreement rate, `spectral_tail_error` = monotonicity violation count, `cond_I_minus_G` and `spectral_radius` are stored as `0` sentinels (not meaningful for this kind).

**Artifact payload shape** is stored under the same `job_artifacts.payload` JSON column with `kind: "cutoff_trace"`. The `cutoff_estimate` field returns `{ month, ci_low, ci_high, fit_quality }` in `YYYY-MM` form.

---

## 8c. Warburg Closed-Form Oracle

The numerical Editor is paired with a closed-form **reference oracle** (`src/lib/warburg.ts`) that ports the unified Warburg theorem into TypeScript. For the gaussian kernel the oracle evaluates the lattice integral analytically via the modified Bessel identity

  ∫₀^∞ t^(ν−1) e^(−A t − B/t) dt = 2 (B/A)^(ν/2) K_ν(2 √(A B))

with `A = σ²`, `B = π μᵀ Q⁻¹ μ`, and `ν = 1 − d/2`. K_{1/2} uses its exact closed form `√(π/(2z)) e^(−z)`; other orders use the integral representation `K_ν(z) = ∫₀^∞ e^(−z cosh t) cosh(ν t) dt`.

The oracle runs at the end of every numerical Editor pass and emits two optional diagnostics on `NumericalArtifactPayload.diagnostics`:

| Field | Source | Verifier check |
|---|---|---|
| `warburg_nu` | `1 − d/2` for the Editor's `s = 1` convention | — (informational) |
| `closed_form_residual` | `‖F_numerical − F̃_oracle‖₂ / ‖F̃_oracle‖₂` over non-zero modes | CHK08 |

A typical pass yields `closed_form_residual ≈ 1e−10` (Bessel quadrature precision) when the numerical integrator is healthy; values above `policy.warburg_residual_tol` (default 0.05) flag systematic drift between the numerical pipeline and the analytic theorem and trigger CHK08.

For non-gaussian kernels, `computeWarburgOracle` returns nulls and CHK08 silently skips — preserving the existing pipeline unchanged.

**Startup self-test.** The remaining theorem identities — the five phase validators (envelope slope = −α, latency cancellation `K(T_now − δ) = 0`, integrability `ν < 1`, Warburg-pole `ν = 1/2`, Mercer slope ≈ −1) — are pure-math cross-checks that depend only on the implementation, not on any per-job input. They run exactly once at server boot via `assertWarburgSelfTest(logger)` in `src/index.ts`; the server refuses to start (and logs a structured error) if any of them fails. This catches numerical-library regressions at deploy time without polluting per-job diagnostics.

---

## 9. Policy Thresholds and Configuration

Policy thresholds are submitted per-job in the `policy_config` field of `POST /api/jobs`. Each threshold maps directly to one or more Verifier checks.

| Field | Default | Check | Description |
|---|---|---|---|
| `spectral_radius_max` | `0.999` | CHK02 | Maximum allowed spectral radius of `G_off` |
| `cond_limit` | `1e6` | CHK03 | Maximum allowed condition number of `I − G_off` |
| `dual_error_tol` | `1e-6` | CHK04 | Maximum allowed dual truncation error |
| `spectral_tail_tol` | `1e-6` | CHK05 | Maximum allowed spectral tail estimate |
| `safety_margin` | `1e-3` | Editor step 8 | Buffer below spectral radius 1 before damping |

**Pluggable hooks:** The Manager supports per-job overrides of all thresholds at submission time. A global default policy is loaded from environment configuration and merged with per-job overrides, with per-job values taking precedence.

---

## 10. Deployment Prerequisites

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | **[current]** PostgreSQL connection string — enforced by `lib/db/src/index.ts` (throws if unset) |
| `VERIFIER_SIGNING_KEY` | Yes (production) | **[current]** Secret key for HMAC-SHA256 artifact signing in `workers/verifier.ts`. Falls back to a hardcoded development key with a warning if unset — **must be overridden in production** |
| `PORT` | Yes | **[current]** Port for the API server — enforced at startup in `artifacts/api-server/src/index.ts` (throws if unset) |
| `NODE_ENV` | Yes | **[current]** Required by Express and pino-http for production behaviour |
| `JOB_TIMEOUT_MS` | No | **[current]** Per-job execution timeout in ms (default 300000) — read in `workers/pipeline.ts` |
| `MAX_CONCURRENT_JOBS` | No | **[spec/planned]** Concurrent pipeline cap; Manager PDR target is ≥ 50. Currently jobs run via `setImmediate` and are not bounded — see follow-up task #8 for persistent queue |
| `DEFAULT_SPECTRAL_RADIUS_MAX` | No | **[spec/planned]** Global override for CHK02 threshold (currently per-job only via `policy_config`) |
| `DEFAULT_COND_LIMIT` | No | **[spec/planned]** Global override for CHK03 threshold |
| `DEFAULT_DUAL_ERROR_TOL` | No | **[spec/planned]** Global override for CHK04 threshold |
| `DEFAULT_SPECTRAL_TAIL_TOL` | No | **[spec/planned]** Global override for CHK05 threshold |

### Database

- PostgreSQL instance reachable at `DATABASE_URL`
- Schema pushed via `pnpm --filter @workspace/db run push` before first deployment
- Tables: `jobs`, `job_artifacts`, `job_diagnostics` must exist with correct column types

### Build

- All packages must typecheck: `pnpm run typecheck`
- API server must build: `pnpm --filter @workspace/api-server run build`
- Codegen must be current: `pnpm --filter @workspace/api-spec run codegen`

---

## 11. Deployment Steps and Health Checks

### Deployment Sequence

1. Set all required environment variables in the deployment environment
2. Run `pnpm install --frozen-lockfile`
3. Run `pnpm run typecheck` — must exit 0
4. Run `pnpm --filter @workspace/api-spec run codegen` — must complete without errors
5. Run `pnpm --filter @workspace/db run push` — applies schema to production database
6. Run `pnpm --filter @workspace/api-server run build` — produces ESM bundle at `artifacts/api-server/dist/index.mjs`
7. Start the API server: `pnpm --filter @workspace/api-server run start` **[current — runs `node --enable-source-maps ./dist/index.mjs`]**
8. **[spec/planned]** Build and serve the React frontend once its artifact is scaffolded: `pnpm --filter @workspace/<frontend-slug> run build` then serve the resulting `dist/` directory. The correct package name is determined when the frontend artifact is created.

### Health Check Endpoint

```
GET /api/healthz
→ 200 { "status": "ok" }
```

This endpoint must respond within 2 seconds for the deployment to be considered healthy. The load balancer or reverse proxy should poll this endpoint every 30 seconds with a 5-second timeout.

### Smoke Tests Post-Deployment

The commands below use shell substitution variables (`$HOST` = deployed hostname, `$JOB_ID` = UUID returned by the create call). These are parameterized examples; substitute real values before running.

```sh
# 1. Health  [current endpoint]
curl -f "https://$HOST/api/healthz"

# 2. Create a job with a minimal synthetic Gaussian kernel  [spec/planned endpoint]
curl -X POST "https://$HOST/api/jobs" \
  -H "Content-Type: application/json" \
  -d '{
    "kernel": { "type": "gaussian", "sigma": 1.0 },
    "Q": [[1,0],[0,1]],
    "truncation": { "M": 2, "r": 3 },
    "latency": { "lambda": 0.5, "delta": 0.1, "Tnow": 0.0 },
    "precision": { "b": 32, "tol": 1e-6 }
  }'

# 3. Poll for final status  [spec/planned endpoint]
curl "https://$HOST/api/jobs/$JOB_ID"
```

---

## 12. Known Limitations — v1 Scope

The following items are explicitly out of scope for the initial deployment:

| Item | Rationale |
|---|---|
| Frontend UI (User Mode and Developer Mode) | Tracked as follow-up task #7. The backend exposes the full contract; UI consumes it via the generated React Query hooks in `lib/api-client-react`. |
| Persistent job queue surviving restarts | Tracked as follow-up task #8. Currently jobs are dispatched in-process via `setImmediate`; if the API server restarts mid-job, in-flight jobs remain in `editor_running`/`verifying` status. |
| Authentication and user accounts | Out of scope for v1. The API has no auth middleware; deploy behind a trusted boundary. |
| Real GPU / distributed numerical compute | Editor runs in-process on Node using a pure-TS math library; no GPU acceleration. |
| External LLM/AGI model inference | No external model calls in v1; `model_pool` is optional and defaults to a canonical synthetic basis. |
| WebSocket real-time streaming | Job status is delivered via client polling (`GET /api/jobs/:id`); WebSocket upgrade is deferred. |
| Export (PDF, CSV) | Not implemented in v1; artifact JSON is returned via the API and can be exported client-side. |
| Artifact encryption at rest | Encryption in transit (TLS) is enforced by the deployment platform; at-rest encryption depends on the database provider. |
| Role-based access control | Access is unenforced in v1; RBAC is required before multi-tenant deployment. |
| Automated signing key rotation | Manual key rotation only — set a new `VERIFIER_SIGNING_KEY` and redeploy. Existing `signed_proof` values become invalid and would need to be re-verified by re-running the Verifier. |
| Performance / load tests | Unit, integration, and fuzz tests are present (90 tests). Sustained-load tests against the Manager PDR target of ≥50 concurrent jobs are deferred. |

---

## 13. Deployment Verification Checklist

The following checklist is structured for a Claude LLM reviewer to execute step-by-step. Each item specifies what to check, where to look, and what the acceptable outcome is. Issue a deployment approval only if all items marked **[BLOCKING]** pass.

---

### A. API Contract Completeness

- [ ] **[BLOCKING] A1** — Verify `lib/api-spec/openapi.yaml` defines all 8 job-management endpoints listed in Section 4. Check that each path, method, request schema, and response schema is present. Flag any missing or mis-typed fields.
- [ ] **[BLOCKING] A2** — Verify that `lib/api-client-react/src/generated/api.ts` and `api.schemas.ts` exist and were regenerated from the current OpenAPI spec (compare `info.version` in the spec with the generation header in the generated files).
- [ ] **A3** — Verify that `GET /api/healthz` is present in the spec and implemented in `artifacts/api-server/src/routes/health.ts`.

### B. Numerical Stability Invariants

- [ ] **[BLOCKING] B1** — Inspect the Editor worker implementation (Step 8 of the numerical pipeline). Confirm the guard `ρ(G_off) ≥ 1 − safety_margin → apply_damping(G_off)` is present **before** the linear system solve. If this guard is missing, the solver can diverge.
- [ ] **[BLOCKING] B2** — Confirm the default value of `safety_margin` is `1e-3` (or stricter). A value of 0 disables the guard entirely.
- [ ] **[BLOCKING] B3** — Confirm `spectral_radius_max` default is strictly less than 1.0. A value ≥ 1.0 would allow unstable artifacts to pass CHK02.
- [ ] **B4** — Verify the `cond_limit` default is set (e.g. `1e6`). An unconfigured condition number bound could allow numerically degenerate solves to proceed silently.

### C. Verifier Check Coverage

- [ ] **[BLOCKING] C1** — Confirm all 8 checks (CHK01–CHK08) are implemented in the Verifier worker. Check for a test or code path that exercises each check ID.
- [ ] **[BLOCKING] C2** — Confirm CHK01 (artifact integrity) recomputes `SHA-256(payload)` independently and compares against `job_artifacts.hash`. The hash must not be taken from the artifact itself.
- [ ] **[BLOCKING] C3** — Confirm CHK06 (causality) verifies the retarded/advanced decomposition and the `iε` prescription. This check must not be a no-op stub.
- [ ] **[BLOCKING] C4** — Confirm CHK07 (privacy) scans the artifact payload for patterns that would indicate sensitive token or raw user data leakage (e.g. regex scan or field allowlist). This check must not be a no-op stub.
- [ ] **C5** — Confirm that a `fail` verdict on any single check results in the overall verdict being `fail` (not `warn`). Check the verdict aggregation logic.
- [ ] **C6** — Confirm the Verifier runs checks with `parallel_checks: true` and completes within 120 seconds under normal load.

### D. Artifact Signing and Key Rotation

- [ ] **[BLOCKING] D1** — Confirm the `VERIFIER_SIGNING_KEY` environment variable is set in the deployment environment and is not the empty string.
- [ ] **[BLOCKING] D2** — Confirm the signing key is never hardcoded in source code. Search for literal strings matching the key value in all source files.
- [ ] **D3** — Confirm there is a documented procedure for rotating `VERIFIER_SIGNING_KEY` (note: automated rotation is out of scope for v1, but the procedure must be documented).
- [ ] **D4** — Confirm that after key rotation, artifacts signed with the old key fail signature validation (not CHK01 hash integrity, which only checks payload hash). The signature verification step must reject any `signed_proof` whose HMAC does not match the current `VERIFIER_SIGNING_KEY`, and the artifact must not be silently re-accepted without re-running the Verifier.

### E. Idempotency and Retry Safety

- [ ] **[BLOCKING] E1** — Confirm `POST /api/jobs` is idempotent when called with the same `job_id`. A duplicate submission must return the existing job, not create a new one.
- [ ] **E2** — Confirm the Manager's retry/backoff logic does not re-run a job that has already reached `complete` or `failed` state.
- [ ] **E3** — Confirm `PUT /api/jobs/:id/artifact` creates a new immutable version (incrementing `version`) rather than overwriting an existing artifact row.

### F. Privacy and Data Isolation

- [ ] **[BLOCKING] F1** — Confirm `job_artifacts.payload` does not store raw user input beyond the structured job descriptor fields. Free-text fields from user input must not appear in artifact payloads.
- [ ] **[BLOCKING] F2** — Confirm there is no route that returns one user's artifact to a different user's request (access scoping must be enforced at the query level once RBAC is implemented — for v1, verify at minimum that job IDs are non-guessable UUIDs).
- [ ] **F3** — Confirm the API logs (pino-http) do not serialize request bodies containing policy config or precision parameters in plain text. Check the `serializers` configuration in `artifacts/api-server/src/app.ts`.

### G. Database Schema and Migrations

- [ ] **[BLOCKING] G1** — Confirm all three tables (`jobs`, `job_artifacts`, `job_diagnostics`) exist in the production database after `pnpm --filter @workspace/db run push`.
- [ ] **G2** — Confirm `job_artifacts.hash` and `job_artifacts.signed_proof` columns exist with correct types (`text`, nullable for `signed_proof`).
- [ ] **G3** — Confirm foreign key constraints are present: `job_artifacts.job_id → jobs.id` and `job_diagnostics.artifact_id → job_artifacts.id`.

### H. Resource Isolation Between Pipeline Jobs

- [ ] **[BLOCKING] H1** — Confirm that concurrent pipeline jobs cannot access or corrupt each other's in-progress artifacts. Verify that artifact reads and writes are always scoped by `job_id` at the query level, with no cross-job shared mutable state in the Editor or Verifier workers.
- [ ] **H2** — Confirm there is a mechanism (e.g. per-job timeouts, `MAX_CONCURRENT_JOBS` cap) that prevents a single long-running numerical solve from exhausting server resources and starving other jobs (the Manager PDR requires resource isolation to avoid "noisy neighbors").
- [ ] **H3** — Confirm numerical tasks (Editor pipeline steps 4, 8) do not block the Node.js event loop indefinitely. Long synchronous compute must either be offloaded (worker threads, child process) or guarded with a per-job timeout that triggers the `failed` state transition.

### I. Deployment Health

- [ ] **[BLOCKING] I1** — `GET /api/healthz` returns `200 { "status": "ok" }` within 2 seconds from the deployed host.
- [ ] **[BLOCKING] I2** — The smoke test job (Section 11) creates a job, advances to `complete` or `complete_with_warnings`, and the returned artifact contains non-null `Phi_coeffs` and `R_coeffs`.
- [ ] **I3** — No `ERROR` level log lines appear in the API server output during the smoke test.
- [ ] **I4** — Confirm `NODE_ENV=production` is set. Development-only overrides must not be active in production (see `artifacts/api-server/src/app.ts`).
- [ ] **I5** — Confirm the API server starts with `pnpm --filter @workspace/api-server run start` (which runs `node --enable-source-maps ./dist/index.mjs`) and that `dist/index.mjs` exists after the build step. The `dev` script (`build` + `start`) must not be used in production.

---

**Approval gate:** All items marked `[BLOCKING]` must pass. Non-blocking items must be documented as known gaps with owner and resolution timeline before a production audience is served.
