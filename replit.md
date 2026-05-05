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
GET  /api/jobs/stats        — aggregate counts by status / kind / verdict + recent_24h
GET  /api/jobs/:id          — job detail with artifact + diagnostics (Warburg fields merged from artifact.payload.diagnostics)
PATCH /api/jobs/:id/status  — update status
PUT   /api/jobs/:id/artifact — upload artifact
POST /api/jobs/:id/work     — dispatch to Editor
POST /api/jobs/:id/verify   — dispatch to Verifier
POST /api/jobs/:id/verdict  — post Verifier verdict
POST /api/jobs/:id/retry    — retry failed job
POST /api/daemon/messages   — **standalone (unbound) Daemon chat** — same wire shape as `/jobs/:id/daemon/messages` but with NO relic conditioning. Used by the splash widget so visitors can converse with the Daemon (with voice playback + an inline sentence bar) before any innoculation has been run. Stateless; nothing persisted server-side.
```

## Frontend: `artifacts/innoculus-web`

React 19 + Vite 7 + TanStack Query app mounted at `/`. Calls the api-server at `/api`. Pages (wouter):

- `/` **Splash** — fullscreen Goldstone-diagram entry portal (NO sidebar). Pure SVG with CSS `@keyframes` animations (`innoculus-flow`, `-pulse-stroke`, `-breathe`, `-core`, `-radiate`, `-blink` defined in `src/index.css`). The diagram has five interactive nodes inside a pulsing lens:
  - **Top portal** (`splash-enter`) — navigates to `/dashboard`.
  - **Bottom portal** (`splash-tutorial`) — navigates to `/tutorial`.
  - **Reckoner** + **Judge** orbs (`splash-reckoner`, `splash-judge`) — speak their role-name voice cue with a prismatic shockwave; no navigation.
  - **Daemon orb** (`splash-daemon`, the centre node) — opens an inline standalone chat anchored below the diagram. First click triggers an unbound-Daemon greeting (POST `/api/daemon/messages`) and plays the daemon-female/male voice clips through a shared `AnalyserNode`; the centre orb's halo + core radii are then driven imperatively from the live RMS amplitude so the orb pulses in sync with the spoken word. The sentence bar below the diagram (`daemon-sentence-bar`, `daemon-transcript`) mirrors the Daemon's current line in large type; the input bar beneath it sends additional turns. The audio infrastructure is shared with the role-name voice plays — single AudioContext per splash mount.
- `/dashboard` Dashboard — `useGetJobStats` + `useListJobs` for tiles and Recent Activity.
- `/submit` Submit — react-hook-form + Zod. **Simplified single form** (Models / Latency / Probes). Spectral kernel, Q, truncation, precision, and all policy thresholds are filled in client-side from a fixed `SPECTRAL_DEFAULTS` constant in `submit.tsx` (matching the pre-simplification form defaults: gaussian σ=1.0, Q=`[[1,0]]`, M=32 r=16, b=53 tol=1e-6). **Q must stay fixed** — the editor's dual-index enumeration is exponential in `Q.length` (~67^d at M=32), so deriving Q from probe count would blow up the spectral pipeline. The form is identical in User and Developer modes.
- `/jobs` All Jobs — paginated registry with filters.
- `/jobs/:id` Detail — pipeline stepper, Verifier checks, artifact viewer, Retry button. `useGetJob` polls every 2.5s while status ∈ {queued, editor_running, verifying} and stops on terminal. Daemon chat panel (`components/daemon-chat.tsx`) appears once the relic is sealed; it embeds the **DaemonOrb** (`components/daemon-orb.tsx`) which pulses on every assistant response. The chat plays the daemon voice (`public/audio/daemon-{female,male}.mp3`, the same clip used on the splash) through a Web Audio AnalyserNode via the `useDaemonVoice` hook (`lib/use-daemon-voice.ts`). The orb's halo + core radius track the AnalyserNode's RMS amplitude every animation frame. **Browser autoplay note**: `voice.prime()` MUST be called inside the send-button click handler so the AudioContext is created/resumed in a user gesture; `voice.play()` is then safe to call later from the async `onSuccess` callback.

For Daemon smoke-testing without sealing a relic, the **splash widget** (see `/` above) is the entry point — its centre Daemon orb opens a chat against the standalone `/api/daemon/messages` endpoint with the same voice + amplitude pulse as the relic-conditioned chat.

Mode toggle: User vs Developer is a global React context (`src/lib/mode-context.tsx`), persisted to localStorage as `innoculus-mode`. The submit form is identical in both modes (it no longer exposes spectral knobs at all). On `/jobs/:id`, User Mode surfaces prose in diagnostics; Developer Mode reveals every metric including the Warburg trio (`closed_form_residual`, `mercer_slope`, `warburg_nu`).

Theme: dark only. Plus Jakarta Sans + Space Mono. **Important**: any `@import url(...)` (e.g. Google Fonts) MUST be the very first line of `src/index.css` — before `@import "tailwindcss"` — otherwise PostCSS silently drops it.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/api-server run test` — run unit + integration tests (51 tests)
- `pnpm --filter @workspace/innoculus-web run dev` — run frontend dev server

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
