# DGX-Innoculus Integration Spec

> Status: design proposal. Nothing in sections 4–15 is built yet. Sections 2–3
> describe the system as it actually exists in this repository today.

This document is the working brief for adding **NVIDIA DGX Spark** (rentable
or BYO) into Innoculus as a per-relic / per-user fine-tuning and inference
substrate. It is written to be self-contained: an LLM or engineer who has
never touched this repo should be able to read it and start building.

---

## 1. How to use this document

**Audience.** Claude or Claude Code (or any other coding assistant), and the
human engineer pairing with it. The document is a *spec*, not an
implementation. It describes proposed end-state, contracts, and trade-offs.

**Workflow we expect.**

1. Paste this whole file as context into a fresh session.
2. For each work session, scope to **one numbered section** (e.g. "implement
   §9 Inference routing contract"). Sections are intentionally
   self-contained — each one names the files it touches and the data shapes
   it produces. The §18 file map tells you which existing file to request
   when expanding a section.
3. Expected per-session artifacts:
   - §5, §7, §8 → schema + endpoint + type sketches you can drop into
     `lib/db/src/schema/` and `artifacts/api-server/src/routes/` (do not
     hand-write the OpenAPI spec; the codegen flow in `lib/api-spec` owns it
     — see §18).
   - §9, §10, §11 → new module(s) under `artifacts/api-server/src/lib/` and
     `artifacts/api-server/src/workers/`.
   - §15 → one PR per phase, each gated on the acceptance criteria in this
     doc.
4. **Do not edit** the spectral or speculative pipelines (`workers/editor.ts`,
   `workers/cutoff-editor.ts`, `workers/verifier.ts`, `workers/cutoff-verifier.ts`)
   while building DGX integration. They are correct as-is and out of scope.
5. **Do not invent file paths or schema fields** that aren't in this doc.
   When uncertain, ask for the file by its §18 entry.

**Conventions in this doc.**
- `proposed` / `new` = does not yet exist.
- A bare path like `artifacts/api-server/src/lib/openai-client.ts` exists today.
- ASCII / mermaid diagrams only; no images.
- Drizzle-style schema sketches are illustrative — the real schema must round-trip
  through `lib/db` and `lib/api-spec` codegen.

---

## 2. Innoculus today

Innoculus is a web app that "innoculates" a target language model against
forgetting and hallucination, by running a two-phase audit that produces a
single signed **relic** the user can interrogate via a Daemon chat.

A submission (called an **innoculation**) carries:

- **Speculative** inputs — a target model, a judge model, and a list of
  dated `{question, answer, date}` probes.
- **Spectral** inputs — a latency profile `(λ, δ, Tnow)`. Other spectral
  inputs (kernel, lattice `Q`, truncation `M/r`, precision `b/tol`) are
  fixed by the form's `SPECTRAL_DEFAULTS` constant
  (`artifacts/innoculus-web/src/pages/submit.tsx:48`). The Spectral pipeline
  is run on every innoculation; it does not depend on the target model.

Pipeline behaviour (one job, kind = `innoculation`):

1. **Spectral phase** (numerical, `workers/editor.ts` + `workers/verifier.ts`):
   builds the Gaussian/Mellin lattice kernel, evaluates `F[μ]`, applies the
   absorber-coupling fixed point, computes diagnostics
   (`spectral_radius`, `cond_I_minus_G`, `dual_truncation_error`,
   `spectral_tail_error`, plus Warburg `closed_form_residual` and
   `warburg_nu`). Verifier runs CHK01–CHK08 and emits a sub-verdict.
   (`mercer_slope` is a separate, theorem-level metric computed once at
   server startup by `lib/warburg-self-test.ts`, NOT part of the per-job
   artifact diagnostics; the API response surface still exposes a
   `mercer_slope` field on `jobDiagnostics`, which is null for ordinary
   jobs.)
2. **Speculative phase** (cutoff trace, `workers/cutoff-editor.ts` +
   `workers/cutoff-verifier.ts`): asks the target model each probe, asks the
   judge model to grade each `(question, ground truth, candidate)`,
   aggregates by month, fits a logistic changepoint to the monthly knew-rate
   curve, and reports `cutoff_estimate = {month, ci_low, ci_high, fit_quality}`.
   Verifier runs CHK01 + CT02–CT05 (judge spot-recheck, monotonicity,
   coverage, PII).
3. **Merge** (`workers/pipeline.ts:runInnoculationCycle`): both phases run
   in parallel. The unified verdict is the worst of the two sub-verdicts.
   The merged payload (`InnoculationArtifactPayload`) carries both
   sub-payloads and per-phase issues.
4. **Daemon chat** (`POST /api/jobs/:id/daemon/messages`): once the relic is
   sealed, a stateless chat endpoint conditions an LLM (default `gpt-5`) on
   a system prompt built from the merged payload. The chat surface
   (`artifacts/innoculus-web/src/components/daemon-chat.tsx`) holds history
   in component state only; nothing is persisted. There is also an unbound
   Daemon at `POST /api/daemon/messages` for the splash page.

Verdict mapping: `pass → status=complete`, `warn → complete_with_warnings`,
`fail → failed`. Spectral remediation (e.g. damping, increasing M/r/b) only
runs on legacy `numerical` jobs; `innoculation` jobs do not auto-retry.

---

## 3. Current architecture

### 3.1 Repo layout (pnpm workspace)

```
artifacts/
  innoculus-web/           # React + Vite + wouter frontend
  api-server/              # Express + Drizzle backend
  mockup-sandbox/          # design canvas, not in scope
lib/
  db/                      # Drizzle schema + pool, exports tables + types
  api-spec/                # OpenAPI source of truth (orval)
  api-zod/                 # generated zod types from the OpenAPI spec
  api-client-react/        # generated react-query hooks for the frontend
```

`pnpm-workspace.yaml` enumerates the packages; the API client / zod / spec
packages are codegen'd — do not edit `lib/api-zod/src/generated/` or
`lib/api-client-react/src/generated/` by hand.

### 3.2 Frontend (`artifacts/innoculus-web`)

Pages: `splash.tsx`, `tutorial.tsx`, `dashboard.tsx`, `jobs.tsx`,
`submit.tsx`, `job-detail.tsx`. The submit form is intentionally narrow:
target model, judge model, judge temperature, latency `(λ, δ, Tnow)`, and
probes. Everything else is `SPECTRAL_DEFAULTS`. The detail page renders the
unified verdict, sub-verdict badges, per-phase issue cards, and the
`<DaemonChat>` surface (which only mounts for sealed `innoculation` relics).

Daemon UI also includes a pre-rendered voice clip and a reactive orb
(`daemon-orb.tsx`, `use-daemon-voice.ts`) — these are presentation, not
something DGX needs to know about.

### 3.3 API server (`artifacts/api-server`)

Express app mounted at `/api` (`app.ts`, `routes/index.ts`). Routes:

- `routes/health.ts` — liveness.
- `routes/jobs.ts` — full job CRUD (create, list, stats, get, status,
  artifact upload, work/verify dispatch stubs, verdict, retry, **and** the
  bound Daemon chat at `POST /jobs/:id/daemon/messages`).
- `routes/daemon.ts` — unbound (splash) Daemon at `POST /daemon/messages`,
  with an in-process per-IP token bucket (5 burst, 0.5/s refill).

### 3.4 Job lifecycle and pipeline orchestration

`POST /api/jobs` validates the descriptor (zod), inserts a row with
`status="queued"`, and `setImmediate(() => runPipeline(jobId))`. There is
no external queue — the pipeline runs inside the API process. A timeout
`JOB_TIMEOUT_MS` (default 300_000) flips the job to `failed` if it overruns.

`runPipeline(jobId)` (`workers/pipeline.ts`):
1. Marks `editor_running`.
2. For up to `MAX_AUTO_RETRIES + 1 = 3` cycles, calls
   `runEditorVerifierCycle()`, which dispatches by descriptor kind:
   - `innoculation` → `runInnoculationCycle()` (parallel
     `runEditor` + `runCutoffEditor`, then parallel
     `runVerifier` + `runCutoffVerifier`, then merge).
   - `cutoff_trace` → `runCutoffEditor` + `runCutoffVerifier`.
   - `numerical` → `runEditor` + `runVerifier`.
3. Inserts the `job_artifacts` row, flips to `verifying`, computes the
   verdict, inserts a `job_diagnostics` row, signs the artifact with
   HMAC(`VERIFIER_SIGNING_KEY`), and stores `signed_proof` on the artifact.
4. On `fail` for non-innoculation jobs, applies `applyRemediation()` and
   loops; innoculation jobs surface failure directly.
5. Final status set per verdict mapping in §2.

### 3.5 The single LLM chokepoint: `lib/openai-client.ts`

**Every** LLM call in the API server goes through `chat({model, messages,
temperature?, max_completion_tokens?})` in
`artifacts/api-server/src/lib/openai-client.ts`. It:

- Lazily constructs a single `OpenAI` SDK client from
  `AI_INTEGRATIONS_OPENAI_BASE_URL` + `AI_INTEGRATIONS_OPENAI_API_KEY`
  (Replit's OpenAI integration proxy).
- Strips `temperature` for `gpt-5` / `o*` models.
- Retries once on transient (408/429/5xx, ETIMEDOUT, ECONNRESET).

Callers today: `cutoff-editor.ts` (target + judge), `cutoff-verifier.ts`
(spot-recheck judge), `routes/jobs.ts` (bound Daemon),
`routes/daemon.ts` (unbound Daemon). **This is the single insertion point
for inference routing in §9.** Nothing else in the codebase talks to an LLM
directly.

### 3.6 Data model (today, three tables)

All in `lib/db/src/schema/`:

- **`jobs`** (`schema/jobs.ts`):
  `id uuid pk`, `kind text` (`numerical|cutoff_trace|innoculation`),
  `status text`, `kernel_params jsonb` (the descriptor),
  `policy_config jsonb`, `current_artifact_id uuid`, `retry_count int`,
  timestamps.
- **`job_artifacts`** (`schema/job-artifacts.ts`):
  `id uuid pk`, `job_id uuid fk`, `version int`, `payload jsonb`
  (`NumericalArtifactPayload | CutoffArtifactPayload | InnoculationArtifactPayload`),
  `hash text`, `signed_proof text`, `created_at`. There is **no** `user_id`
  column today — jobs are not user-scoped.
- **`job_diagnostics`** (`schema/job-diagnostics.ts`):
  flat row of the four legacy spectral metrics + `verdict` + `issues jsonb[]`.
  Cutoff/innoculation rows reuse this row (with cutoff metrics packed into
  the spectral fields — see `pipeline.ts:299`). Warburg fields live in the
  artifact `payload.diagnostics`, not in this row.

---

## 4. Where DGX Spark fits

Three workload classes in Innoculus benefit from local Spark compute. None
of them are bottlenecked by raw FLOPs alone — they're bottlenecked by
*per-tenant model state* (a custom adapter / persona) that is wasteful to
host on a hosted API.

| # | Workload | Why DGX Spark |
|---|---|---|
| 1 | **Speculative target inference** — answering each `probe.question` during `cutoff-editor.ts`. Today every probe hits `chat({model: probe.model, ...})` against the hosted proxy. | Spark can host a fixed base + per-relic LoRA for *target-model role-play*. Big unified-memory + FP4 throughput is well-matched to a single 8B–70B base with adapter swaps. |
| 2 | **Spectral dense linalg** — the Editor's lattice eigendecomposition, `matInverse`, `topEigenvectors`, Warburg Bessel quadrature. Currently CPU JS in `workers/editor.ts` + `lib/math.ts` + `lib/warburg.ts`. | Spark's tensor cores + unified memory dwarf Node.js double-precision linear algebra. Even at modest M/r the speedup is 10×+. |
| 3 | **Daemon chat** — every `POST /jobs/:id/daemon/messages`. Today routes through the hosted proxy with the static `gpt-5` system prompt. | A per-relic Daemon LoRA + a per-user *judge persona* LoRA can be hot-swapped on a shared Spark base. Cuts hosted-API spend, and (more importantly) enables personalisation that a hosted API can't easily provide. |

**Realistic note on Spark's strengths and limits.**

- ✅ **Unified CPU/GPU memory** (≈128 GB, depends on model) means a
  single 8B–70B base + dozens of LoRA adapters fit without spilling.
- ✅ **FP4 + dense matmul throughput** is sufficient for interactive (single-
  digit qps) per-relic inference and for short fine-tuning runs (LoRA on a
  few hundred to few thousand pairs).
- ❌ **Memory bandwidth** is well below H100/B200. A single Spark is not
  competitive for high-qps multi-tenant serving of a 70B base.
- ❌ **No multi-Spark NVLink fabric.** Sharded inference across Sparks is
  not on the table; treat each Spark as one independent serving unit.
- ❌ Cold-start of a base model is slow (tens of seconds) — adapter swap on
  a warm base is fast (sub-second). The architecture must keep bases warm
  and treat adapters as the swappable unit.

---

## 5. Target architecture

```
              ┌─────────────────┐
              │ innoculus-web   │
              └────────┬────────┘
                       │ react-query (lib/api-client-react)
              ┌────────▼────────┐
              │ api-server      │
              │  routes/jobs.ts │
              │  routes/daemon  │
              │  workers/*      │
              │                 │
              │  ┌───────────┐  │     resolve(user_id, relic_id, role)
              │  │ inference │──┼──────────┐
              │  │ router    │  │          │
              │  └─────┬─────┘  │          │
              └────────┼────────┘          │
                       │                   │
       ┌───────────────┼───────────────┐   │
       │               │               │   │
       ▼               ▼               ▼   ▼
 hosted OpenAI   Innoculus-fleet   user-BYO Spark   training queue
 (fallback)      Spark (tenant)    Spark (tenant)   (per-relic adapter
                                                    + per-user judge)
```

Pieces being added:

1. **Inference routing layer.** A new `lib/inference-router.ts` that owns
   the decision of *where* a given LLM call goes. The existing `chat()` in
   `lib/openai-client.ts` is rewritten to consult it; all current callers
   keep their call signature. (See §9 for the contract.)
2. **Spark-side inference service.** Per Spark, an OpenAI-compatible HTTP
   endpoint (`/v1/chat/completions`) that serves a single base model and
   loads the requested LoRA adapter per request. Implementation choice
   (vLLM with multi-LoRA, NIM container, llama.cpp, ...) is **out of scope
   for this doc** — picked in phase 2.
3. **Optional Spark-side spectral compute service.** A second endpoint
   (`POST /spectral/compute`) that accepts the spectral descriptor and
   returns the same `NumericalArtifactPayload` shape `runEditor` produces.
   The API server falls back to the in-process JS path if no Spark is
   bound. *This is the only piece that involves Python on the Spark side
   — and only because the math libs are easier there.*
4. **Per-relic Daemon LoRA adapters.** One adapter per `relic_id` (=
   `job_artifacts.id` of the sealed innoculation relic). Trained from the
   relic's prior Daemon chat history + the merged payload. Versioned.
5. **Per-user judge persona adapters.** One adapter per `user_id`. Trained
   from the judge's call history (`judge_call_log`, §7) — the user's own
   labelling preferences, reified.
6. **Rental / BYO split.** A user either points Innoculus at their own Spark
   (BYO) or rents one from Innoculus's fleet. The protocol between the API
   server and the Spark is identical in both cases — see §6.

---

## 6. Product shape decision

Three options:

| Option | Pros | Cons |
|---|---|---|
| **A. BYO Spark only.** Users register their own Spark URL + token. | Zero hosting cost. No GPU procurement risk. Privacy story is trivial — the data never leaves the user's hardware. | Only useful to users who own a Spark. No revenue stream. Onboarding friction is high. |
| **B. Innoculus-hosted fleet only.** Innoculus runs its own pool of Sparks and rents them by the hour. | Lowest user friction. Recurring revenue. We control the OS image / model versions. | We hold relic data on our hardware → bigger CT05 surface. We bear procurement + capacity risk. No path for power users with their own Spark. |
| **C. Hybrid (recommended).** BYO-first protocol; Innoculus's own Sparks are exposed *as tenants of the same protocol* via an internal "rental" record that auto-provisions the connection. | Single code path on the API server. Power users self-host. Casual users rent. The hosted-fleet code is just BYO with the registration step automated. | Slightly more design work up front (the "rental → spark" mapping has to be cleanly factored). |

**Recommendation: C, hybrid.** The reason is architectural, not product: if
we build (B) first we will end up special-casing the rental code path, and
adding BYO later means a refactor of every routing decision. Building the
BYO protocol first gives us a single resolution path
(`(user_id, relic_id, role) → spark`) that internal rentals bind into the
same way external Sparks do.

---

## 7. Data model additions

All proposed; none of these tables exist today. Drizzle sketches are
illustrative — the actual columns and constraints belong to whoever
implements §15 phase 1 / 2.

### 7.1 `sparks` (proposed)

Registration record for a Spark, BYO or hosted.

```ts
// lib/db/src/schema/sparks.ts (proposed)
export const sparksTable = pgTable("sparks", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull(),    // user that registered it
  kind: text("kind").notNull(),                    // 'byo' | 'fleet'
  displayName: text("display_name").notNull(),
  baseUrl: text("base_url").notNull(),             // OpenAI-compatible endpoint
  apiKeyEncrypted: text("api_key_encrypted").notNull(),
  baseModel: text("base_model").notNull(),         // e.g. 'meta-llama/Llama-3.1-8B-Instruct'
  capabilities: jsonb("capabilities").$type<{
    supportsLoraAdapters: boolean;
    supportsSpectralCompute: boolean;
    maxConcurrency: number;
  }>().notNull(),
  status: text("status").notNull(),                // 'online' | 'offline' | 'draining'
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  createdAt, updatedAt,
});
```

Retention: rows are permanent; a deleted Spark transitions to
`status='offline'` and stops being routed to.

### 7.2 `rentals` (proposed)

Active or historical reservation of a Spark by a user.

Columns: `id`, `userId`, `sparkId fk sparks`, `startedAt`, `endsAt`,
`status` (`active|expired|cancelled`), `billingPlan` (`hourly|per_run|tokens`),
`metadata jsonb`.

For hosted-fleet Sparks, the rental row is what gates routing: a routing
lookup for `(user_id, relic_id, role)` only resolves to a fleet Spark if
the user has an active rental on it.

### 7.3 `daemon_adapters` (proposed)

Per-relic LoRA adapter versions.

Columns: `id`, `relicId fk job_artifacts.id`, `version int`,
`baseModel text`, `trainingRunId fk training_runs`, `storageUri text`,
`evalScore real`, `status` (`training|active|retired`), `createdAt`.

Uniqueness: `(relicId, version)`. The "active" version per relic is the one
the resolver returns.

Retention: keep all versions for a relic; mark old versions `retired` once
a newer one outperforms on the eval harness (§10).

### 7.4 `judge_adapters` (proposed)

Per-user judge persona LoRA adapter versions. Same shape as
`daemon_adapters` but keyed on `userId` instead of `relicId`.

### 7.5 `training_runs` (proposed)

A single fine-tuning execution.

Columns: `id`, `kind` (`daemon|judge`), `targetId uuid` (relic id or user
id), `sparkId fk sparks`, `baseModel`, `framework text` (e.g. `peft-lora`,
left as a string so we can swap), `corpusHash text`, `hyperparams jsonb`,
`status` (`queued|running|complete|failed`), `metrics jsonb`, `createdAt`,
`completedAt`.

### 7.6 `judge_call_log` (proposed)

Append-only log of every judge call made by `cutoff-editor.ts` and
`cutoff-verifier.ts`. This is the corpus the per-user judge persona is
trained on (§11).

Columns: `id`, `userId`, `jobId fk jobs`, `probeQuestion text`,
`groundTruth text`, `candidate text`, `judgeModel text`, `score real`,
`reasoning text`, `phase` (`grade|recheck`), `createdAt`.

Retention: indefinite, with a per-user purge endpoint (§12).

---

## 8. API surface additions

All proposed; none exist today. Format: `METHOD PATH — purpose
(req → res)`.

**Spark registration & lifecycle**
- `POST /api/sparks` — register a BYO Spark.
  Req: `{displayName, baseUrl, apiKey, baseModel, capabilities}`.
  Res: `{id, status, lastHeartbeatAt}`.
- `GET /api/sparks` — list sparks the user has access to (owned + rented).
- `DELETE /api/sparks/:id` — deregister.
- `POST /api/sparks/:id/heartbeat` — Spark-initiated liveness ping; updates
  `lastHeartbeatAt`.

**Rentals**
- `POST /api/rentals` — start a rental on a fleet Spark.
  Req: `{billingPlan, durationHours?}`. Res: `{id, sparkId, endsAt}`.
- `GET /api/rentals` — list current user's rentals.
- `POST /api/rentals/:id/cancel` — early termination.

**Daemon adapter training & version selection**
- `POST /api/relics/:relicId/daemon-adapters/train` — kick off a training
  run for this relic on the user's selected Spark.
  Req: `{sparkId, hyperparams?}`. Res: `{trainingRunId}`.
- `GET /api/relics/:relicId/daemon-adapters` — list versions + eval scores.
- `POST /api/relics/:relicId/daemon-adapters/:version/activate` — set
  active version.

**Judge persona training**
- `POST /api/users/:userId/judge-adapter/train` —
  Req: `{sparkId, hyperparams?}`. Res: `{trainingRunId}`.
- `GET /api/users/:userId/judge-adapter` — list versions.
- `POST /api/users/:userId/judge-adapter/:version/activate`.

**Inference routing resolution (read-only, mostly internal)**
- `GET /api/inference/resolve?user_id=…&relic_id=…&role=daemon|judge|target`
  — Res: `{baseUrl, model, adapter?, sparkId?, source: 'spark'|'hosted'}`.
  Used by debugging UI; the actual routing happens in-process via the
  resolver (§9). API key never returned over the wire.

All new routes require auth (sessions don't exist today — phase 0
prerequisite is to add user auth, see §15 phase 1 dependencies).

---

## 9. Inference routing contract

This is the central piece of phase 1 and the entry point for everything
DGX-side. Today, `chat()` in `lib/openai-client.ts` is a single global
client. After this contract lands, `chat()` is a thin wrapper over the
resolver.

### 9.1 Inputs and outputs

```ts
// artifacts/api-server/src/lib/inference-router.ts (proposed)

type Role = "daemon" | "judge" | "target";

export interface RouteRequest {
  userId: string;
  relicId?: string;       // required for role=daemon, optional for judge/target
  role: Role;
  // Hint for callers that already know which model they want (target/judge).
  // The resolver may honour or override based on routing rules.
  preferredModel?: string;
}

export interface RouteResolution {
  baseUrl: string;       // OpenAI-compatible
  apiKey: string;        // tenant key for that Spark, OR hosted-proxy key
  model: string;         // the base model on the Spark, OR e.g. 'gpt-4o'
  adapter?: string;      // LoRA adapter id to load, if any
  sparkId?: string;      // null when source = 'hosted'
  source: "spark" | "hosted";
}

export async function resolveInference(req: RouteRequest): Promise<RouteResolution>;
```

### 9.2 Resolution rules (in order)

1. **`role = daemon`, with `relicId`:**
   - Look up the relic's owner. If the user has an active `daemon_adapters`
     record for `relicId` AND has access to a Spark hosting that
     adapter's base model → return that Spark + adapter.
   - Else fall back to hosted (current `gpt-5` behaviour).
2. **`role = judge`:**
   - If the user has an active `judge_adapters` record AND access to a
     Spark hosting its base model → return that Spark + adapter.
   - Else fall back to hosted (current judge model from
     `cutoff_trace.judge_model`).
3. **`role = target`:**
   - If `preferredModel` is hosted (`gpt-*`, `claude-*`, …) → return hosted.
   - If `preferredModel` matches a registered Spark's `baseModel` → return
     that Spark, no adapter (target inference is unspecialised).
   - Else fall back to hosted.

### 9.3 Fallback discipline

- A Spark whose `lastHeartbeatAt` is older than N seconds (configurable,
  default 60s) is considered offline and skipped.
- On Spark-side HTTP error or timeout, the resolver records the failure on
  the `sparks` row and falls back to hosted *for that single call*. The
  request is **not** silently retried against hosted if the caller
  specifically wanted the adapter (Daemon chat with adapter must surface a
  clear "adapter unavailable, falling back to base" warning).

### 9.4 Integration with `openai-client.ts`

`chat()` is rewritten as:

```ts
// artifacts/api-server/src/lib/openai-client.ts (proposed change)

export async function chat(
  opts: ChatOptions & { route: RouteRequest },
): Promise<string> {
  const r = await resolveInference(opts.route);
  const client = getOrCreateClient(r.baseUrl, r.apiKey);
  // If r.adapter, pass it as an OpenAI extra_body field; vLLM/NIM accepts
  // {"model": r.model, "lora_request": {"lora_name": r.adapter, ...}}.
  const params = buildChatParams(opts, r);
  return await callWithRetry(client, params);
}
```

Every existing caller (`cutoff-editor.ts`, `cutoff-verifier.ts`,
`routes/jobs.ts`, `routes/daemon.ts`) is updated to pass a `route` field.
The `chat()` shape change is a one-shot migration, gated on phase 1.

### 9.5 Auth between API server and Spark

Every Spark gets a per-tenant API key issued at registration. The API
server stores it encrypted with `SPARK_KEY_ENCRYPTION_KEY` (new env). The
Spark validates the key on every request; nothing else. Network options
discussed in §12.

---

## 10. Per-relic Daemon fine-tuning pipeline

A relic's Daemon today is just `gpt-5` with the system prompt built by
`buildDaemonSystemPrompt()` in `routes/jobs.ts:485`. The proposal: train a
LoRA per relic so the Daemon can speak in the relic's idiom — its policy
thresholds, its cutoff behaviour, its previous chat turns.

### 10.1 Corpus construction

Per relic, the training corpus is built from:

1. **The merged payload** (`InnoculationArtifactPayload`):
   - The system prompt itself becomes a constant `system` turn.
   - Spectral diagnostics, sub-verdicts, cutoff estimate, and the policy
     thresholds become *Q&A pairs* generated by templating
     ("What's the relic's spectral radius?" → numeric answer; "What's your
     cutoff month?" → `cutoff_estimate.month`; etc.). ~30 templated pairs
     per relic.
2. **Per-relic Daemon chat history.** New table `daemon_chat_log`
   (proposed alongside §7, owed by the user-auth task) records every
   turn pair. Each `(userMsg, assistantMsg)` pair becomes an
   instruction/response example.
3. **Held-out probe set.** Take 20% of the relic's `cutoff_trace.probe_results`
   (stratified by month) and reserve them — they're never seen by the
   training corpus and form the eval (§10.4).

### 10.2 Training

- **LoRA / QLoRA recommendation.** Start with rank-16 LoRA on `q_proj`,
  `v_proj`, `k_proj`, `o_proj` of the chosen base. QLoRA (4-bit base) only
  if the chosen base doesn't fit in Spark unified memory uncompressed.
- **Epochs:** 2–3, AdamW, cosine schedule. With ≤500 pairs per relic this
  is minutes on a Spark.
- **Framework choice:** open. Hugging Face PEFT is the obvious default;
  Axolotl wraps it nicely. NeMo + NIM is the NVIDIA-preferred path. Pick
  in §15 phase 3.

### 10.3 Adapter versioning

`daemon_adapters` rows are append-only. A new training run produces a new
`version`. The "active" version is whichever has the best held-out eval
score AND has been manually `activate`d (the activate endpoint lets the
user roll back).

### 10.4 Eval harness — what "improved" means

For each held-out probe:
1. Ask the Daemon (with the new adapter) the question via `chat()`.
2. Score against ground truth using the *base* judge model (NOT the
   user's persona adapter — we want a stable yardstick).
3. Aggregate: knew-rate before vs after the adapter's claimed cutoff.

The adapter is "improved" iff:
- Held-out knew-rate-after-cutoff drops (the Daemon stops claiming
  knowledge it shouldn't have); AND
- Held-out knew-rate-before-cutoff does not drop more than 0.05; AND
- Diagnostic-question accuracy (templated pairs) is ≥ 90%.

Numbers are illustrative — real thresholds get tuned in phase 3.

---

## 11. Per-user judge persona pipeline

Today's judge is a stock model with a strict system prompt
(`cutoff-editor.ts:JUDGE_SYSTEM`). A given user's idea of "substantially
matches" may differ — a strict legal user wants exact dates; a casual
user accepts paraphrases. Per-user judge personas reify that.

### 11.1 Lifting judge call history

`judge_call_log` (§7.6) starts being written by `cutoff-editor.ts` and
`cutoff-verifier.ts` as soon as user auth lands (every call already
carries question, ground truth, candidate, score, reasoning — we just
have to persist them).

### 11.2 Training corpus

Per user, take all `judge_call_log` rows where the user manually corrected
the score (a corrections UI is implied but out of scope here) AND the
score was confidently assigned (`reasoning` non-empty). Format as:

```
input: { question, ground_truth, candidate }
output: { "score": ..., "reason": "..." }
```

Same JSON output contract as `JUDGE_SYSTEM` so the parser
(`parseJudgeResponse` in `cutoff-editor.ts`) is unchanged.

### 11.3 Eval

Held-out 20% of corrections. The persona is "better" iff its
`{score}` matches the corrected score on > X% of held-out cases, AND
its agreement with the *base* judge on uncorrected cases is ≥ a floor
(so the persona doesn't drift wildly).

### 11.4 Expected impact on CT02 / recheck cost

`chkCT02JudgeAgreement` in `cutoff-verifier.ts` re-judges a sample of
probes and measures disagreement against the original score. With a stable
per-user persona used for both grading and rechecking, the CT02
disagreement rate should drop sharply (the same persona judging twice
should agree ≈ deterministically at temperature 0). This in turn lets us
*reduce* `min_recheck_count` (currently 3) and cut judge LLM cost without
weakening verification.

---

## 12. Tenant isolation and security

### 12.1 Adapter swap discipline on a shared base

A Spark serving multiple tenants holds one base model and N LoRA adapters.
The serving framework MUST guarantee:
- Each request explicitly names its adapter; there is no "default LoRA".
- LoRA application is per-request, not per-process. (vLLM with
  multi-LoRA, NIM with adapter mounts, etc. all support this.)
- Adapter weights are loaded from per-tenant storage paths; the API
  server's per-tenant key gates which adapters that tenant may name.

### 12.2 Network options between API server and Spark

In rough order of preference:
1. **Tailscale tailnet.** Each Spark is a node on Innoculus's tailnet;
   the API server reaches it on a `100.x` address. Zero public exposure.
2. **Cloudflare Tunnel (cloudflared).** Spark dials out to a tunnel; the
   API server hits a Cloudflare-hosted hostname locked to mTLS or an
   `Authorization` header with the per-tenant key.
3. **mTLS over public IP.** Acceptable but operationally expensive.

For BYO Sparks, (1) is the recommended default — we publish a Tailscale
join script. For the hosted fleet, (1) or (2) — Spark hardware lives in a
colo and the tunnel is set up at imaging time.

### 12.3 CT05 expansion

The current `chkCT05Privacy` (`cutoff-verifier.ts`) scans probe text for
email/phone/SSN regex patterns at verify time. With DGX, PII can also leak
*into* training data (judge call history, daemon chat history). Two
additions:

- **Pre-train scrub.** Before any training corpus is sent to a Spark,
  re-run the same regex set (and maybe a wider one — names, addresses)
  over the corpus. Drop matching examples; require the user to confirm if
  > N% are dropped.
- **Per-tenant data residency.** Adapter weights, judge_call_log rows, and
  daemon_chat_log rows for a user are NEVER replicated across Sparks. A
  user's adapter lives on exactly one Spark (the one used to train it,
  unless explicitly migrated).

### 12.4 Consent surface

Three new consent moments, each requiring an explicit user action (not
just a ToS clause):
1. First time user enables a Spark integration.
2. First time user kicks off a training run on their own data ("we will
   train on your judge call history").
3. First time user shares a relic publicly (must scrub adapter from the
   shared artifact bundle).

ToS update wording is in §16 (open question).

---

## 13. Operational concerns

### 13.1 Cold-start and warm pool

- Loading an 8B base from disk into Spark unified memory: ~10–30 s.
  Loading a LoRA on a warm base: <1 s.
- Strategy: Sparks keep their assigned base model resident at all times.
  Adapters are LRU-cached (with a configurable cache size, e.g. 16
  adapters) and pulled from object storage on miss.
- For the hosted fleet: a small warm pool (2–4 Sparks per supported
  base model) sized off the rolling-hour rental load.

### 13.2 Storage growth math

Per relic, one LoRA adapter at rank 16 on an 8B base ≈ 30–60 MB. With:
- 10k active relics × 3 versions kept = 30k adapters → ≈ 1.5 TB.
- 1k active users × 2 judge versions = 2k adapters → ≈ 100 GB.

Budget: ≤ 5 TB object storage in the first year. Retention policy:
auto-retire (delete weights, keep metadata) any version with
`status='retired'` and `createdAt < now() − 180d`.

### 13.3 Observability

Per training run: `training_runs.metrics` carries
`{loss_curve, eval_scores, gpu_utilization, wall_time_s, peak_vram_gb}`.

Per inference call routed to a Spark: structured log with
`{userId, relicId, role, sparkId, adapter, latencyMs, tokensIn, tokensOut}`.
Store in the existing pino log stream initially; phase 5 escalates to a
proper metrics store if call volume warrants.

Eval scores over time per adapter are first-class — the
`/api/relics/:relicId/daemon-adapters` listing returns
`[{version, evalScore, createdAt, status}]`.

### 13.4 Failure modes and fallback

| Failure | Behaviour |
|---|---|
| Spark heartbeat stale (> 60 s) | Resolver skips the Spark; falls back to hosted. Surface a dashboard banner. |
| Spark rejects request (HTTP 5xx) | One retry against the same Spark; on second failure, fallback to hosted for that call only and increment a per-Spark error counter. |
| Adapter not loaded on Spark | Resolver falls back to the same Spark's base (no adapter) and emits a `degraded_inference` warning to the caller. |
| Training run crashes | `training_runs.status='failed'`, `metrics.failure_reason` populated. UI offers retry. |
| Spark deregistered with active rentals | Rentals auto-cancel with prorated credit; users re-routed to fleet pool. |

---

## 14. Cost and billing model options

| Model | Pros | Cons |
|---|---|---|
| **Per-hour rental.** User pays for wall-clock time the Spark is reserved to them. | Predictable for the user. Matches how datacenter GPU is sold. | Idle Sparks burn user money. Hard for casual / single-relic users. |
| **Per-training-run.** Flat fee per fine-tune; inference is free during the rental. | Aligns cost to value (training is the expensive thing). | Cost of inference is invisible — abuse risk on long Daemon chats. |
| **Per-1k tokens.** Same shape as hosted APIs. | Familiar. Trivial to bill. Matches Innoculus's existing hosted-API spend model. | Hides our actual cost driver (GPU-hours, not tokens). Margin compression as token counts grow. |
| **Hybrid (recommended).** Per-1k tokens for inference + flat fee per training run + a small monthly base for adapter storage. | Each line item maps to an actual cost driver. Predictable for power users; pay-as-you-go for casuals. | Three meters to implement. |

**Recommendation: hybrid.** Per-1k tokens for inference is the only sane
default given that's how hosted APIs are priced (so users can compare); a
flat per-training-run fee captures the GPU-hour spike honestly; adapter
storage is small enough to roll into a $X/month base or be free up to a
quota. Billing provider choice (Stripe, Paddle, …) is §16 open question.

---

## 15. Phased delivery plan

Each phase ends with a shippable, testable increment. Acceptance is
measured against the contracts in §7–§13.

### Phase 1 — Pluggable inference routing (foundation)

- **Goal:** Land the resolver and rewire `chat()` so that, with no Sparks
  registered, behaviour is identical to today.
- **Scope:** §9 in full. `lib/inference-router.ts` (new). `chat()`
  rewritten. All four call sites updated to pass a `route`. User auth
  (any solution — Replit Auth, Clerk) added so `userId` is available.
  `jobs.userId` and `job_artifacts.userId` columns added.
- **Dependencies:** none in this doc (auth provider chosen separately).
- **Acceptance:**
  - Existing innoculation flow passes end-to-end with `source='hosted'`
    on every call.
  - `GET /api/inference/resolve` returns hosted for every role with no
    Sparks registered.
  - Type checks pass; existing tests pass.
- **Biggest risk:** auth retrofit. Mitigation: do auth in a separate PR
  *before* this phase starts.

### Phase 2 — BYO Spark + judge hosting on it

- **Goal:** A user can register their own Spark, mark it as their judge
  endpoint, and see judge calls land on it.
- **Scope:** `sparks` table, `POST/GET/DELETE /api/sparks`,
  `POST /api/sparks/:id/heartbeat`. Resolver rule for `role=judge`. Per-
  Spark API key encryption. A reference Spark-side serving config
  (vLLM+OpenAI compat, no LoRA yet) documented.
- **Dependencies:** phase 1.
- **Acceptance:**
  - User registers a local mock OpenAI-compatible server as a "Spark";
    judge calls during a cutoff job route to it; CT02 still works.
- **Biggest risk:** auth/network setup friction for end users. Mitigation:
  Tailscale-based onboarding script + a "test connection" button.

### Phase 3 — Per-relic Daemon adapters

- **Goal:** A user can train, version, and activate a Daemon LoRA per
  relic on their Spark, and Daemon chat for that relic uses the adapter.
- **Scope:** §10 in full. `daemon_adapters` + `training_runs` tables.
  `POST /api/relics/:id/daemon-adapters/train` + listing + activate.
  Spark-side training entry point (fine-tune script invoked over HTTP or
  SSH — simplest first). `daemon_chat_log` table starts being written.
- **Dependencies:** phase 2.
- **Acceptance:**
  - Train an adapter on a relic with ≥ 50 chat turns; held-out eval shows
    measurable improvement on the §10.4 metrics; activation makes Daemon
    chat route through the adapter.
- **Biggest risk:** corpus is too small to learn anything. Mitigation:
  the templated diagnostics pairs guarantee a baseline corpus.

### Phase 4 — Per-user judge persona fine-tune

- **Goal:** A user with corrections on judge calls can train a judge
  persona; it becomes their default judge.
- **Scope:** §11 in full. `judge_adapters` table. `judge_call_log`
  table starts being written from phase 1 (so by here we have months of
  data). Corrections UI on the job-detail page (could ship in a parallel
  task but blocks phase 4 acceptance).
- **Dependencies:** phase 2 (Spark serving), and a corrections UI.
- **Acceptance:**
  - Train on ≥ 200 corrections; held-out agreement with corrections
    > 75%; CT02 disagreement rate measurably lower than with stock judge.
- **Biggest risk:** users won't correct judges. Mitigation: bake
  corrections into the existing job-detail issue cards; default-on
  recheck-disagreement prompts.

### Phase 5 — Innoculus-hosted fleet + billing

- **Goal:** A user with no hardware can rent an Innoculus Spark by the
  hour and use it identically to a BYO Spark.
- **Scope:** `rentals` table + endpoints. Hosted Spark provisioning
  (operations, not code). Billing integration. Pricing surface in the UI.
- **Dependencies:** phase 2 (the rental Spark uses the BYO protocol).
- **Acceptance:**
  - User starts rental → resolver returns the rented Spark for that user
    immediately → first inference call lands on it within 10 s of rental
    start.
- **Biggest risk:** GPU procurement and uptime. Mitigation: start with a
  pool of 2 Sparks; monitor utilisation before scaling.

### Phase 6 — Multi-tenant scheduling

- **Goal:** A single Spark in the hosted pool can serve several tenants
  concurrently with adapter swaps.
- **Scope:** Adapter LRU cache on Spark side. Per-tenant rate limits.
  Heartbeat/load broadcasted so the resolver picks the least-loaded Spark
  for stateless calls.
- **Dependencies:** phase 5.
- **Acceptance:**
  - 10 concurrent users on 2 Sparks each see < 2× single-user latency on
    Daemon chat; no cross-tenant adapter leakage in adversarial test.
- **Biggest risk:** the chosen serving framework's multi-LoRA story
  doesn't actually deliver on swap latency. Mitigation: validate this in
  phase 2 with a benchmark before committing.

---

## 16. Open questions

Decisions still owed by the product owner before any implementation:

1. **Base model family.** Llama 3.1 8B / 70B Instruct? Qwen 2.5? Mistral
   Small? Choice drives Spark VRAM footprint + adapter format.
2. **Fine-tuning framework.** Hugging Face PEFT? Axolotl? NVIDIA NeMo?
   Drives Spark-side container, training script ergonomics, and ops
   ownership.
3. **Inference serving framework.** vLLM (multi-LoRA mature, OpenAI-compat
   first-class), NIM (NVIDIA-supported, glossier), TGI, llama.cpp?
4. **Billing provider.** Stripe is the obvious default. If not, why?
5. **Network topology default for BYO.** Tailscale (recommended) vs.
   Cloudflare Tunnel vs. published URL + mTLS.
6. **Retention policy on raw judge / chat logs.** Default 180 days as
   sketched in §13.2 — confirm or override.
7. **ToS update wording for "we may train on your data."** Required
   before any training run from real user data.
8. **User auth provider.** Phase 1 needs `userId` in the request — pick
   before phase 1 starts.

---

## 17. Appendix: glossary

- **Relic** — the sealed `job_artifacts` row produced by an `innoculation`
  job. Carries the unified verdict and both sub-payloads. The Daemon is
  conditioned on it.
- **Innoculation** — the job kind. One submission, two parallel phases,
  one merged relic.
- **Spectral phase** — the numerical pipeline (Gaussian/Mellin lattice,
  absorber-coupling fixed point, dual-truncation diagnostics, Warburg
  closed-form residual). Implemented in `workers/editor.ts` +
  `workers/verifier.ts`.
- **Speculative phase** — the cutoff trace pipeline (probe target,
  judge-grade, monthly aggregate, logistic changepoint fit). Implemented
  in `workers/cutoff-editor.ts` + `workers/cutoff-verifier.ts`.
- **cutoff_trace** — both the legacy job kind and the sub-payload kind
  inside an innoculation relic.
- **Daemon** — the LLM persona conditioned on a sealed relic, exposed to
  the user via chat at `POST /api/jobs/:id/daemon/messages`. The
  *unbound* Daemon at `POST /api/daemon/messages` is the splash variant
  with no relic.
- **Judge** — the LLM that grades a probe candidate against ground truth
  in the speculative phase.
- **Adapter** — a LoRA / QLoRA weight delta loaded on top of a base
  model. Per-relic for Daemon, per-user for Judge.
- **Rental** — a time-bound reservation of a hosted-fleet Spark for a
  single user.
- **BYO Spark** — a Spark the user owns and registers themselves; the API
  server only holds connection metadata + an encrypted API key.

---

## 18. Appendix: file map

Existing files most likely to be referenced when expanding sections of
this doc.

**API server** (`artifacts/api-server/src/`)
- `app.ts` — Express bootstrap; mounts `/api`.
- `routes/index.ts` — composes health + jobs + daemon routers.
- `routes/jobs.ts` — full job CRUD, descriptor zod schemas, bound Daemon
  chat handler + system prompt builder. **The bound Daemon prompt builder
  (`buildDaemonSystemPrompt`) is what a Daemon LoRA must replicate — read
  it before designing the §10 corpus.**
- `routes/daemon.ts` — unbound Daemon endpoint with per-IP rate limiter.
- `workers/pipeline.ts` — orchestrator; `runInnoculationCycle` is where
  Spectral and Speculative are merged.
- `workers/editor.ts` — spectral pipeline.
- `workers/verifier.ts` — spectral checks CHK01–CHK08; HMAC signing.
- `workers/cutoff-editor.ts` — speculative pipeline; **all current LLM
  calls for grading live here** and become `judge_call_log` writes.
- `workers/cutoff-verifier.ts` — speculative checks CT02–CT05; the
  spot-recheck judge call is the second `judge_call_log` writer.
- `lib/openai-client.ts` — **the single LLM chokepoint**; the file the
  inference-router contract slots into.
- `lib/warburg.ts` — closed-form Warburg oracle (referenced by the
  spectral compute service in §5.3).

**Frontend** (`artifacts/innoculus-web/src/`)
- `pages/submit.tsx` — innoculation submission form; `SPECTRAL_DEFAULTS`
  is the source of truth for "what spectral inputs are fixed".
- `pages/job-detail.tsx` — verdict UI, issue cards, mounts `<DaemonChat>`.
- `components/daemon-chat.tsx` — the bound Daemon chat UI; what a per-
  relic adapter ultimately serves.

**Schema** (`lib/db/src/schema/`)
- `jobs.ts` — `jobsTable` + descriptor TS types.
- `job-artifacts.ts` — `jobArtifactsTable` + payload TS types
  (`NumericalArtifactPayload`, `CutoffArtifactPayload`,
  `InnoculationArtifactPayload`).
- `job-diagnostics.ts` — `jobDiagnosticsTable` + `DiagnosticIssue`.
- `index.ts` — re-exports the above.

**Generated client surface** (do not hand-edit)
- `lib/api-spec/` — OpenAPI source.
- `lib/api-zod/src/generated/` — generated zod types.
- `lib/api-client-react/src/generated/` — generated react-query hooks
  used by the frontend (`useCreateJob`, `useGetJob`, `useChatWithDaemon`,
  …).
