# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (ESM bundle → `dist/index.mjs`)

## Project: Innoculus

A spectral self-force computation pipeline exposed as a REST API. The pipeline implements three in-process subagents:

### Manager (REST layer — `artifacts/api-server/src/routes/jobs.ts`)
Gateway for all job operations. Handles idempotent job creation, status transitions, artifact storage, and pipeline orchestration.

### Editor (`artifacts/api-server/src/workers/editor.ts`)
12-step numerical pipeline:
1. Load job descriptor
2. Build Gaussian or Mellin base kernel k0(t)
3. Apply latency modulation K(t) = (1 − exp(−λ(t−T+δ))) × k0(t)
4. Enumerate dual lattice indices {μ : μᵀQμ ≤ M²}
5. Compute Poisson summation coefficients F(μ) via Gauss-Legendre quadrature
6. Compute short-time expansion coefficients a_n for UV regularization
7. Build absorber coupling matrix G_off (normalized for contractivity)
8. Compute Dirac symmetric subtraction S = F − F_sym
9. Apply spectral-radius damping if ρ(G_off) ≥ 1 − safety_margin
10. Solve absorber fixed point Φ = (I − G_off)⁻¹ S via Gaussian elimination
11. Compute radiation reaction R = Φ − F_ret
12. Project Φ, R onto spectral basis; output artifact with diagnostics

### Verifier (`artifacts/api-server/src/workers/verifier.ts`)
Parallel CHK01–CHK07 checks with HMAC-SHA256 signed verdict:
- CHK01: Artifact integrity (SHA-256 hash verification)
- CHK02: Spectral radius < policy.spectral_radius_max (fail)
- CHK03: Condition number cond(I − G_off) < policy.cond_limit (warn)
- CHK04: Dual truncation error ≤ policy.dual_error_tol (warn)
- CHK05: Spectral tail estimate ≤ policy.spectral_tail_tol (warn)
- CHK06: Causality check — Phi_coeffs and R_coeffs valid/non-empty (fail)
- CHK07: Privacy check — no unexpected top-level fields, no sensitive patterns (fail)

## Database Schema

- `jobs` — job state machine (queued → editor_running → verifying → complete/complete_with_warnings/failed)
- `job_artifacts` — immutable versioned artifact snapshots with hash + HMAC-signed proof
- `job_diagnostics` — verifier results, check issues, metric recomputation

## Key API Endpoints

```
POST /api/jobs              — create job (idempotent via job_id)
GET  /api/jobs              — list jobs (paginated)
GET  /api/jobs/:id          — job detail with artifact + diagnostics
PATCH /api/jobs/:id/status  — update status
PUT   /api/jobs/:id/artifact — upload artifact
POST /api/jobs/:id/work     — dispatch to Editor
POST /api/jobs/:id/verify   — dispatch to Verifier
POST /api/jobs/:id/verdict  — post Verifier verdict
POST /api/jobs/:id/retry    — retry failed job
```

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/api-server run test` — run unit + integration tests (51 tests)

## Key Files

- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth for all endpoints)
- `lib/db/src/schema/` — Drizzle ORM schema (jobs, job-artifacts, job-diagnostics)
- `artifacts/api-server/src/lib/math.ts` — pure TypeScript matrix ops + Gauss-Legendre integration
- `artifacts/api-server/src/workers/editor.ts` — 12-step numerical pipeline
- `artifacts/api-server/src/workers/verifier.ts` — CHK01–CHK07 + HMAC signing
- `artifacts/api-server/src/workers/pipeline.ts` — Manager orchestration
- `artifacts/api-server/src/routes/jobs.ts` — all job REST routes

## HMAC Signing

Verifier uses `VERIFIER_SIGNING_KEY` env var (falls back to dev key). Proof is deterministic — HMAC-SHA256 over `{artifact_hash, recomputed_metrics, verdict}`.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
