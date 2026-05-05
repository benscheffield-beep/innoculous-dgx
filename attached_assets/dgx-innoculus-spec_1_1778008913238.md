# DGX-Innoculus Handoff Spec

**Status:** Design proposal, pre-implementation. No code in scope.
**Audience:** External engineers and LLMs (Claude / Claude Code) working on the DGX Spark integration without prior project context.
**Source date:** 2026-05-04
**Repo state:** post-Warburg-oracle merge (HEAD `a83669c` plus rev-2 fixes); see Appendix B for file map.

---

## 0. How to use this document

This document is the working specification for adding DGX Spark inference (and optional fine-tuning) to Innoculus. It is structured so that an LLM session can be scoped to a single section without losing context.

**Recommended scoped workflows:**

| If you are… | Read | Skim |
|---|---|---|
| Writing the inference router | §1, §2, §9 | §3, §5 |
| Building the Spark-side service | §1, §4, §5, §9, §12 | §13 |
| Sizing storage and ops | §7, §13, §14 | §5 |
| Deciding on the rental model | §1, §6, §13, §14 | §3 |
| Doing security review | §3, §9, §11, §12 | §7 |

**Each section is expected to produce specific artifacts:**

- §7 → Drizzle schema diff and migration plan
- §8 → OpenAPI delta
- §9 → A `routeInference()` function spec with concrete signature
- §10–11 → Training-run job descriptors
- §15 → Six implementation tickets with acceptance criteria

**Conventions used throughout:**

- *proposed* / *new* / *future* — the item does not yet exist in the codebase.
- File paths or endpoint names cited without those qualifiers exist today and were verified against HEAD before this doc was written.
- Drizzle sketches are illustrative; column types and constraints to be finalized at implementation time.

---

## 1. Innoculus today

Innoculus audits a target language model and produces a *relic* — a sealed, signed artifact summarizing two co-equal evaluations of that model. Once a relic exists, a *Daemon* persona conditioned on the relic is available for chat-style interrogation.

**An innoculation has two phases:**

- **Spectral phase** (job kind `numerical`). A deterministic numerical pipeline that constructs a latency-modulated kernel, sums it over a dual lattice, builds an absorber-coupling matrix, solves a fixed-point linear system, projects onto a top-r spectral basis, and packages the resulting coefficients with a battery of error and stability diagnostics. The pipeline is implemented in pure TypeScript and uses a closed-form Bessel oracle (CHK08) to cross-check the numerical integrator. See `artifacts/api-server/src/workers/editor.ts` and `lib/warburg.ts`.

- **Speculative phase** (job kind `cutoff_trace`). A probe-based knowledge-cutoff trace. The user supplies (question, ground-truth answer, date) tuples. The pipeline calls the target model, scores its response with a judge LLM, aggregates by month, and fits a logistic changepoint to estimate the model's knowledge cutoff with a 95% confidence interval. See `artifacts/api-server/src/workers/cutoff-editor.ts`.

A unified `innoculation` job runs both phases and merges their sub-verdicts. The frontend submission form (`artifacts/innoculus-web/src/pages/submit.tsx`) captures both shapes in a single request.

**The merged verdict** combines two phase-level verdicts (each `pass` / `warn` / `fail`) into a single innoculation verdict. The job-detail page (`job-detail.tsx`) renders one unified verdict badge with two sub-verdict badges next to it. Issues are namespaced (`spectral:CHK08`, `speculative:CT02`) so per-phase issue lists can be reconstructed from the unified diagnostics record.

**The relic** is the merged artifact stored in `job_artifacts` rows with `kind = "innoculation"`. The standalone numerical and cutoff_trace verifiers both produce HMAC-SHA256 `signed_proof` values keyed by `VERIFIER_SIGNING_KEY` (via `signArtifact()` in `verifier.ts`). However, the *merged* innoculation pipeline currently sets `signed_proof = "innoculation:${hash}"` rather than an HMAC — see §12 for the security implication and the recommendation to fix before §15 Phase 3.

Once sealed, the user can chat with the bound Daemon at `POST /api/jobs/:id/daemon/messages`. A separate *standalone Daemon* (`POST /api/daemon/messages`) is reachable from the splash page before any relic exists; same wire shape, no relic context, public/unauthenticated with per-IP token-bucket rate limiting. **Daemon chat history is held only in browser component state** (see `daemon-chat.tsx`); conversations are ephemeral and not persisted server-side. This is a deliberate design choice and has consequences for §10.

**What "innoculation" means.** The intuition is that a probed-and-spectrally-characterized model carries a dated certificate of what it knew and how it behaved at audit time. Whether the Spectral phase produces a measurement of the target model is a real architectural question — see §3.

---

## 2. Current architecture

```
                          ┌──────────────────────────┐
                          │   innoculus-web (React)  │
                          │   submit · job-detail    │
                          └────────────┬─────────────┘
                                       │ HTTP /api
                                       ▼
┌────────────────────────────────────────────────────────────────────┐
│                       Express API server                            │
│                                                                     │
│  routes/jobs.ts ─────┐                                              │
│  routes/daemon.ts ───┼──► workers/pipeline.ts ──► Editor ──► Verifier│
│                      │       │                                      │
│                      │       ├──► workers/editor.ts (Spectral)      │
│                      │       └──► workers/cutoff-editor.ts (Spec.)  │
│                      │              │                                │
│                      │              ▼                                │
│                      │       lib/openai-client.ts ◄──── (chokepoint) │
│                      │              │                                │
│                      ▼              ▼                                │
│                  PostgreSQL    OpenAI-compatible API                 │
│                  (Drizzle)     (gpt-4o, gpt-4o-mini, …)              │
└────────────────────────────────────────────────────────────────────┘
```

**Components:**

- **Frontend** (`artifacts/innoculus-web/`) — React + Vite. Two pages relevant here: `submit.tsx` (initiate an innoculation) and `job-detail.tsx` (view results, retry, chat with the Daemon). User-mode and developer-mode toggle controls how much detail is shown.
- **API server** (`artifacts/api-server/`) — Express 5 + Drizzle ORM, monorepo workspace. Stateless HTTP. No auth in v1; deploy behind a trusted boundary.
- **Database** — PostgreSQL with three tables: `jobs`, `job_artifacts`, `job_diagnostics`. JSONB columns hold the kernel/policy/artifact payloads.
- **LLM access** — All outbound LLM calls go through `artifacts/api-server/src/lib/openai-client.ts`, which exports a single `chat()` function targeting an OpenAI-compatible endpoint. Configured via `AI_INTEGRATIONS_OPENAI_BASE_URL` and `AI_INTEGRATIONS_OPENAI_API_KEY`. **This is the integration chokepoint for the routing layer.**

**Job lifecycle:**

```
queued → editor_running → verifying → complete | complete_with_warnings | failed
```

The Manager (in `routes/jobs.ts` and `workers/pipeline.ts`) advances jobs through the lifecycle. For innoculation jobs, both phases run; their Editor outputs are merged into a single artifact and verified.

**LLM call sites — there are exactly three, all through `chat()`:**

1. **Target model probing** — `cutoff-editor.ts` calls `chat({ model, messages, max_completion_tokens: 256 })` once per probe with the model under audit.
2. **Judge grading** — `cutoff-editor.ts` calls `chat({ model: judge_model, ... })` once per probe; `cutoff-verifier.ts` calls it again on a sampled subset for the CT02 spot-recheck.
3. **Daemon chat** — `routes/daemon.ts` (and its bound counterpart) calls `chat({ model: DAEMON_MODEL, ... })` per user turn.

There are no other outbound LLM calls.

**Verifier checks (current):**

- *Numerical (Spectral):* CHK01 (artifact integrity hash), CHK02 (spectral radius < threshold), CHK03 (condition number), CHK04 (dual truncation error), CHK05 (spectral tail), CHK06 (causality), CHK07 (privacy), CHK08 (closed-form residual against the Bessel oracle).
- *Cutoff (Speculative):* CHK01 (artifact hash), CT02 (judge spot-recheck disagreement), CT03 (post-cutoff monotonicity), CT04 (per-month coverage), CT05 (PII regex scan).

---

## 3. An architectural caveat that affects DGX scoping

Before proposing a target architecture in §5, one fact about the current Spectral phase bears on which workloads benefit from DGX hardware.

The Spectral phase takes user input through `submit.tsx`. The form captures `(lambda, delta, tnow)` — three latency-profile scalars. Every other Spectral input is hardcoded in `SPECTRAL_DEFAULTS`:

```ts
kernel = { type: "gaussian", sigma: 1.0 }
Q = [[1, 0]]                  // 1D lattice; pinned for compute reasons
truncation = { M: 32, r: 16 }
precision = { b: 53, tol: 1e-6 }
```

The Spectral phase therefore does not depend on the target model in any way. It is a deterministic function of three user-chosen scalars plus a set of constants. Two innoculations of GPT-4o and Claude with the same `(lambda, delta, tnow)` produce bit-identical Spectral diagnostics.

**Implications for DGX scoping:**

- The Spectral phase will run faster on DGX hardware. It will not become *more meaningful*. Whether the diagnostics are intentionally ceremonial, intentionally model-agnostic, or a placeholder for future model-conditioning is a product decision outside this document's scope.
- The Speculative phase **does** depend on the target model — every probe is a real LLM call. The Daemon also depends on the LLM. These are the workloads where local hosting changes the unit economics and the privacy profile.
- If the team intends to make the Spectral phase model-conditional before the DGX integration ships, that work should be sequenced *before* §15 Phase 1, because the routing contract (§9) needs to know whether Spectral inputs should be resolved per relic.

This is flagged once, here. The rest of the doc treats the Spectral phase as it currently exists.

---

## 4. Where DGX Spark fits

DGX Spark is NVIDIA's small-form-factor desktop AI workstation — a Grace-Blackwell unified-memory box (~128 GB), Linux + CUDA, intended primarily for local LLM development and inference. It is a workstation, not a managed hosting platform: there is no platform-level concept of HTTP autoscaling, TLS termination, or zero-downtime deploys. A Spark in a rack is a host you SSH into and run services on.

**Three workload classes in Innoculus:**

| Workload | Frequency | Latency-sensitive | Benefits from DGX | Reason |
|---|---|---|---|---|
| Target probing (Speculative phase) | N probes × innoculations/day | No (offline batch) | Yes | Local OSS inference removes per-probe API cost; throughput-bound, batches well |
| Judge grading | 1× per probe + spot-recheck | No | Yes | Same as above; cheaper judge models tolerable as judge reliability is verified by CT02 |
| Daemon chat | Per user turn | Yes (interactive) | Yes | Eliminates per-turn API cost, enables persona fine-tuning, lower per-turn latency for local user (assuming Spark is near user or near server) |
| Spectral phase | Per innoculation | No | **Limited** — see §3 | Pure-TS math, runs in milliseconds on commodity Node; DGX accelerates a workload that isn't bottlenecked |

**Realistic notes on Spark's strengths and limits:**

- *Strength: unified memory.* A 128 GB unified pool fits 70B models in 4-bit quant comfortably and frontier OSS models (e.g., Llama 3.x 70B Instruct, Qwen 2.5 72B) in 8-bit. No host-device copies, lower effective latency for KV-cache-heavy workloads.
- *Strength: FP4 throughput.* Blackwell's FP4 path makes inference of FP4-quantized models substantially cheaper. Useful for the judge and for the Daemon.
- *Limit: memory bandwidth.* Roughly 270 GB/s — well below datacenter Hopper/Blackwell parts (~3–8 TB/s on H100/H200/B200). For pure inference this caps single-stream tokens/sec; throughput-bound workloads (batched judge grading) are less affected than latency-sensitive single streams.
- *Limit: not a hosting target.* Putting a Spark behind a public DNS record is the wrong shape. Sparks live on private networks and are reached via tunnels (Tailscale, Cloudflare Tunnel) or VPN.
- *Limit: single-host concurrency.* Sparks are single-machine; they do not autoscale. Fleet operation requires explicit scheduling and a load balancer (see §13).

**What this means for the integration target:**

- A Spark is well-suited to host the *inference* layer (target, judge, Daemon).
- A Spark is well-suited to run *fine-tuning runs* (LoRA / QLoRA on the order of a few hundred million tokens; multi-day training is feasible).
- A Spark is **not** the place to host the API server itself, the database, or the frontend. Those continue to live on the existing managed runtime (Replit Autoscale or equivalent).
- The integration is therefore a *split-host* architecture: managed API server in front, Spark(s) behind, traffic between them gated by an inference router.

---

## 5. Target architecture

```
                     ┌──────────────────────────────┐
                     │     innoculus-web (React)    │
                     └──────────────┬───────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────┐
│                      API server (managed)                         │
│  routes/jobs.ts · routes/daemon.ts · workers/pipeline.ts          │
│                                                                   │
│                lib/openai-client.ts (wrapped)                     │
│                          │                                        │
│                          ▼                                        │
│                lib/inference-router.ts  (NEW, §9)                 │
│                /            |           \                         │
└───────────────┼─────────────┼────────────┼────────────────────────┘
                │             │            │
                ▼             ▼            ▼
         ┌──────────┐  ┌────────────┐  ┌──────────────────┐
         │  OpenAI  │  │ User-BYO   │  │ Innoculus-hosted │
         │ (fallback)│  │   Spark    │  │  Spark (rented)  │
         └──────────┘  └────┬───────┘  └────────┬─────────┘
                            │                   │
                            ▼                   ▼
              ┌──────────────────────────────────────────┐
              │     Spark inference service (NEW)        │
              │   • OpenAI-compatible HTTP endpoint      │
              │   • base + adapter swap per request      │
              │   • optional spectral-compute service    │
              │   • optional training-runner service     │
              └──────────────────────────────────────────┘
```

**The proposed end state has three additions:**

1. **An inference router in the API server** keyed on `(user_id, relic_id, role)` where `role ∈ { target, judge, daemon }`. Resolves to `{ baseUrl, apiKey, model, adapter? }`. Slots in immediately above `openai-client.ts` (or wraps it). See §9 for the contract.
2. **A Spark-side inference service** exposing an OpenAI-compatible HTTP API (so the existing `chat()` function works against it without modification). Loads a base model in unified memory once; swaps adapters per request. Recommendation: vLLM with LoRA hot-swap, or NVIDIA NIM if its adapter story matures; both are evaluated in §10.
3. **An adapter store** (object storage + DB rows) holding versioned LoRA weights per relic (Daemon adapters) and per user (judge adapters). The router picks the right adapter at request time.

**Optional fourth addition** if the team chooses to make the Spectral phase model-conditional or larger-scale: a Spark-side spectral compute service exposing a small RPC for `runEditor(descriptor)` and returning the same artifact shape. Out of scope for the initial integration; mentioned for symmetry.

**The split-host trust boundary** runs between the API server and the Spark service. Per-Spark API keys, mTLS or an authenticated tunnel (Tailscale / Cloudflare Tunnel), and per-tenant request signing handle authentication. See §12.

---

## 6. Product shape decision: BYO vs hosted vs hybrid

There are three coherent product offerings:

**(a) BYO Spark.** The user provides their own DGX Spark, runs the Spark-side inference service themselves (we publish the Docker image), and points Innoculus at it via an admin-supplied URL + API key. Innoculus stores no model weights and runs no inference fleet.

- *Pros:* Zero hardware capex for Innoculus. Full data isolation — user data never leaves user infra. Strongest privacy story.
- *Cons:* Tiny addressable market (people who own DGX Sparks). Setup burden on the user. Support surface includes the user's hardware.

**(b) Innoculus-hosted fleet.** Innoculus operates a fleet of Sparks, schedules user inference onto them, charges per use. Users see a managed product with a "compute tier" toggle.

- *Pros:* Largest addressable market. Predictable user experience. Fine-tuning and adapter storage are first-class.
- *Cons:* Real capex, real fleet operations (§13), real multi-tenancy concerns. We become a small-scale GPU host.

**(c) Hybrid: BYO-first protocol with Innoculus's own Sparks exposed as tenants on the same protocol.** A Spark — anyone's — registers itself with the API server. The router treats Innoculus's own Sparks as just another registered tenant. Users can either bring their own or rent time on ours.

**Recommendation: hybrid (c).**

The reasoning is structural rather than commercial. Both (a) and (b) require building most of the same pieces: a Spark-side service with an OpenAI-compatible API, an inference router, an adapter store, per-tenant auth. The only thing (b) adds on top of (a) is an Innoculus-operated fleet. If we build the BYO protocol first (Phase 1–2 in §15), Innoculus's own Sparks fall out as a special case: they register the same way a user-owned Spark would. We then layer billing and scheduling on top (Phase 5).

This sequences the riskiest, hardest pieces (multi-tenant scheduling, billing) *last*, after the protocol shape has been pressure-tested by real BYO users. It also means we can ship value to power users before we've solved fleet ops.

The trade-off: in the BYO-first phasing, the addressable market in Phases 1–4 is narrow (DGX Spark owners). That's an honest cost. The compensating benefit is that the people who own DGX Sparks are also the people most likely to be early adopters of a model-audit product — there's a population overlap.

---

## 7. Data model additions

All proposed; no existing tables change. Drizzle sketches are illustrative.

### `sparks` *(proposed)*

A registered Spark instance. One row per physical box (BYO or Innoculus-owned).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `owner_user_id` | uuid FK → users.id | Null for Innoculus-owned |
| `name` | text | User-supplied label |
| `base_url` | text | Internal-network URL (Tailscale, etc.) |
| `api_key_hash` | text | We store only a hash; rotation rotates the secret |
| `network_topology` | text | enum: `tailscale` / `cloudflare_tunnel` / `mtls_direct` |
| `capabilities` | jsonb | base_models[], max_concurrent, supports_lora, supports_training |
| `health_state` | text | enum: `healthy` / `degraded` / `unreachable` |
| `last_seen_at` | timestamptz | Updated by health probe |
| `created_at` | timestamptz | |

Retention: indefinite while owner active; soft-delete on owner offboarding.

### `rentals` *(proposed)*

A time-bounded grant of a Spark to a user. Innoculus-owned Sparks have rental rows; BYO Sparks do not (the owner uses their own Spark directly).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | Renter |
| `spark_id` | uuid FK → sparks.id | |
| `started_at`, `ended_at` | timestamptz | `ended_at` null while active |
| `cost_cents`, `currency` | int, text | Captured at billing time |
| `status` | text | `pending` / `active` / `ended` / `aborted` |

### `daemon_adapters` *(proposed)*

A per-relic LoRA adapter for the Daemon. **Note:** §10 discusses whether this should exist at all; if the answer is "system-prompt injection is sufficient," this table is only used for the per-user *judge* adapters and the Daemon-adapter rows are never written.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `relic_id` | uuid FK → job_artifacts.id | |
| `version` | int | Monotonic per relic |
| `base_model` | text | e.g. `qwen2.5-7b-instruct` |
| `weights_uri` | text | S3-style URI, range-readable |
| `weights_size_bytes` | bigint | |
| `eval_score` | float8 | Held-out eval metric |
| `created_at` | timestamptz | |

### `judge_adapters` *(proposed)*

A per-user LoRA adapter for the judge. **Note:** §11 raises a real concern about whether this is product-defensible; the table exists in the design for completeness but the Phase 4 work in §15 is gated on resolving that concern.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | |
| `version` | int | Monotonic per user |
| `base_model` | text | |
| `weights_uri` | text | |
| `eval_score_held_out` | float8 | Against held-out probes scored by *another* judge |
| `created_at` | timestamptz | |

### `training_runs` *(proposed)*

A record of every fine-tuning execution.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `kind` | text | `daemon_relic` / `judge_user` |
| `target_id` | uuid | relic_id or user_id depending on kind |
| `spark_id` | uuid FK → sparks.id | |
| `base_model`, `framework` | text, text | |
| `hyperparams` | jsonb | LR, rank, alpha, epochs, etc. |
| `corpus_size_examples` | int | |
| `started_at`, `completed_at` | timestamptz | |
| `status` | text | `queued` / `running` / `succeeded` / `failed` |
| `output_adapter_id` | uuid | FK to daemon_adapters.id or judge_adapters.id |
| `eval_log` | jsonb | Step-level losses, eval scores |

### `judge_call_log` *(proposed)*

Lifts the judge calls currently embedded in `cutoff_artifacts.probe_results` into their own queryable table. Required to build a per-user judge-training corpus without re-deriving from JSON blobs.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | |
| `job_id` | uuid FK → jobs.id | |
| `probe_question`, `probe_answer`, `model_answer` | text | |
| `judge_model` | text | The base judge that scored it |
| `judge_score` | smallint | 0 or 1 |
| `judge_reasoning` | text | |
| `created_at` | timestamptz | |

Retention: this table accumulates training data on every probe. Privacy implications covered in §12.

---

## 8. API surface additions

All proposed. Method + path + purpose; full request/response schemas to be added at implementation time.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/sparks` | Register a Spark (owner supplies url + api_key + capabilities) |
| `GET` | `/api/sparks` | List sparks visible to caller (own + Innoculus-public) |
| `DELETE` | `/api/sparks/:id` | Deregister |
| `POST` | `/api/sparks/:id/healthcheck` | Probe a Spark; updates `health_state` |
| `POST` | `/api/rentals` | Begin a rental of an Innoculus-owned Spark |
| `GET` | `/api/rentals/:id` | Status |
| `POST` | `/api/rentals/:id/end` | End early |
| `POST` | `/api/training-runs` | Submit a training-run job (kind, target_id, hyperparams) |
| `GET` | `/api/training-runs/:id` | Poll status, eval log |
| `POST` | `/api/training-runs/:id/cancel` | |
| `GET` | `/api/relics/:id/adapters` | List Daemon adapters for a relic |
| `POST` | `/api/relics/:id/adapters/:version/select` | Pin a specific adapter version for chat |
| `GET` | `/api/users/me/judge-adapters` | List own judge adapters |
| `POST` | `/api/users/me/judge-adapters/:version/select` | Pin a judge adapter version |
| `POST` | `/api/inference/resolve` *(internal)* | Returns `{baseUrl, apiKey, model, adapter}` for a `(user_id, relic_id, role)` tuple |

The last endpoint is internal; the resolver function (§9) is the consumer. It exists as an HTTP endpoint primarily for testing and for Spark-side services that need to know which adapter they should be loading.

---

## 9. Inference routing contract

The router is the integration's load-bearing piece. It sits immediately above (or wraps) `openai-client.ts`.

### Function signature

```ts
interface RouteRequest {
  user_id: string;
  relic_id: string | null;          // null for standalone Daemon, target probing
  role: "target" | "judge" | "daemon";
  // Optional hints; resolver may ignore.
  preferred_spark_id?: string;
  budget_cents_remaining?: number;
}

interface RouteResolution {
  base_url: string;          // OpenAI-compatible endpoint
  api_key: string;           // Per-Spark or per-tenant
  model: string;             // Base model name as the Spark service expects
  adapter: string | null;    // LoRA adapter ID, or null for base
  spark_id: string | null;   // null if falling back to upstream OpenAI
  fallback_chain: string[];  // ['spark:abc', 'spark:def', 'openai'] for transparency
}

function routeInference(req: RouteRequest): Promise<RouteResolution>;
```

### Resolution rules (priority order)

1. **Daemon role + relic present:** Find Daemon adapter for `relic_id`; pick latest version unless user has pinned an earlier one. Resolve to the Spark hosting that adapter. If none, fall through to (4).
2. **Judge role + user has pinned judge adapter:** Resolve to Spark hosting the user's pinned judge adapter. If none, fall through to (4).
3. **Target role:** Use the user's preferred Spark (from rental or BYO ownership). Falls through to (4) if no Spark available or unhealthy.
4. **Fallback:** Upstream OpenAI-compatible endpoint, using the API server's existing `AI_INTEGRATIONS_OPENAI_*` env vars. This preserves existing behavior bit-for-bit when no DGX integration is configured.

### Fallback rules

- A Spark in `health_state = unreachable` is skipped without retry.
- A Spark in `degraded` is used but logged.
- Hard timeout per Spark request: 60s (matches existing `openai-client.ts` timeout).
- On any 5xx or timeout from a Spark, fall back to next in `fallback_chain` once. Do not retry indefinitely; let `chat()`'s existing retry logic handle transient errors at the resolved endpoint.

### Auth

- API server → Spark: per-Spark API key, sent as `Authorization: Bearer`. Spark validates and either accepts or 401s.
- Network: requests travel over Tailscale, Cloudflare Tunnel, or mTLS. Public-internet traffic between API server and Spark is **out of scope** in v1.

### Where it slots into `openai-client.ts`

Two options, with a recommendation:

**Option A (recommended): wrap `chat()`.** Add a thin wrapper:

```ts
export async function chat(opts: ChatOptions, ctx: RouteRequest): Promise<string> {
  const route = await routeInference(ctx);
  const client = getClientFor(route);
  // existing call, but with route.model, route.api_key
}
```

Every existing call site already knows its `(user_id, relic_id, role)` context. Pass it explicitly. Avoids globals; testable.

**Option B: thread-local / async-local context.** A `RouteContext` provided by middleware, picked up implicitly by `chat()`. Less invasive at call sites but harder to reason about.

Option A is cheaper to test and more honest. The number of call sites is small (three, listed in §2), so the explicit threading cost is bounded.

---

## 10. Per-relic Daemon fine-tuning pipeline — *with caveats*

The session plan calls for fine-tuning a LoRA adapter per relic so that each Daemon "knows" its relic. This section describes how it would work *and* surfaces a real concern about whether it should exist at all.

### Concern: fine-tuning may be the wrong tool

A relic is a small, structured artifact:

- Numerical diagnostics (`spectral_radius`, `cond_I_minus_G`, `dual_truncation_error`, `closed_form_residual`, `mercer_slope`, `warburg_nu`, etc.) — ~10 floats.
- Cutoff trace (probe results, monthly aggregates, fitted cutoff with CI).

This is on the order of kilobytes of structured data per relic, not a conversational corpus. As a fine-tuning target it is:

- *Tiny.* Even with synthetic instruction-pair generation off the relic, you'd be hard-pressed to assemble a corpus large enough to meaningfully shift a model's weights without overfitting.
- *Structured.* The data is already retrievable as JSON. A retrieval-augmented system prompt — "here is the relic; answer the user's question about it" — gives the Daemon access to the same information without any training.
- *Non-conversational.* The relic doesn't teach the model how to *converse*; it teaches it what to *say*. The conversational pattern comes from the base model.

**The standalone Daemon's system prompt** (`routes/daemon.ts`) already demonstrates the pattern: a structured persona prompt, no fine-tuning, conversation works fine. The bound Daemon could extend this by injecting the relic into the system prompt and use the same approach.

### What to build first

A retrieval-augmented bound Daemon. Inject the relic into the system prompt at chat time. Compare against a few-shot baseline. Measure whether users find it useful.

If the answer is "yes, but it could be better," only then evaluate fine-tuning, with a *specific* falsifiable hypothesis about what fine-tuning will improve over retrieval (e.g., "users want the Daemon to internalize a personality derived from the relic's verdict, which retrieval can't carry").

### If fine-tuning happens anyway: how it would work

**Corpus construction.** A practical constraint shapes this work: real user-Daemon conversations are not available as a corpus. `daemon-chat.tsx` holds chat history only in browser component state ("nothing is persisted server-side and refreshing the page resets the conversation"). There is no `daemon_chat_log` table, by design. Synthetic generation is therefore the only path.

For each relic, generate (instruction, response) pairs synthetically using a strong instruction-tuned model (e.g. GPT-4o or Claude) on:

- Questions about the spectral diagnostics ("Was the spectral radius healthy?")
- Questions about the cutoff estimate and its confidence ("How sure are we about the cutoff date?")
- Questions about specific probes ("What did the model get wrong in November 2023?")
- Stylistic anchoring ("Speak as the calm Daemon defined in the system prompt.")

Target ~500–2000 pairs per relic. This is a synthetic dataset; the relic is the seed. The synthetic-only constraint is one more reason retrieval-augmented system-prompt injection (the recommended baseline) may be the right answer — it skips the synthetic-generation cost entirely.

**Framework.** LoRA via PEFT (Hugging Face `peft`) or QLoRA via Unsloth. Recommendation: start with PEFT for clarity; consider Unsloth or NVIDIA NeMo if Spark-specific speedups matter. Avoid a fully-managed framework (Replicate, Together) because the data must stay on-Spark for the privacy story (§12).

**Adapter versioning.** Every training run produces a new `daemon_adapters` row with monotonic version. Keep latest N per relic (default N=3); evict older versions to save storage.

**Eval harness.** A held-out probe set per relic. Score the Daemon's answers to held-out probes against ground truth using an LLM judge *not* used during training. "Improved" = strictly higher eval score than the retrieval-augmented baseline. **If the fine-tuned adapter does not beat retrieval, do not ship it.**

**Quantitative bar.** Define improvement as a 5+ percentage-point lift in held-out QA accuracy and a non-degradation in conversational fluency (rubric-graded by a separate LLM judge). Below that, the cost (compute, storage, version management) is not justified.

---

## 11. Per-user judge persona pipeline — *with a structural concern*

Fine-tuning a per-user judge promises that a user's judge becomes "calibrated to" their evaluation preferences. This section describes the pipeline and raises a structural concern that gates whether it should ship.

### Structural concern: agreement ≠ accuracy

A judge fine-tuned on a user's prior judgments will, by construction, agree more with that user's prior judgments. There are three ways this can be good and one way it can be bad:

- *Good (real preferences):* If a user genuinely judges "match" more strictly than the base judge (e.g., demands exact dates), a fine-tuned judge that adopts that strictness is more useful to them.
- *Good (domain calibration):* A user evaluating models on legal facts may want a judge that understands legal-citation form. Fine-tuning helps.
- *Good (style normalization):* A user may consistently mark answers below a length threshold as "incomplete." A fine-tuned judge picks up the convention.
- *Bad (sycophancy):* A user may be judging inconsistently or with bias. A fine-tuned judge inherits the inconsistency, then *amplifies* it because the user trusts the judge more after fine-tuning.

The eval harness must distinguish these. Otherwise a per-user judge is indistinguishable from a more-agreeable judge, and the team cannot know whether the feature is providing accuracy or just confirmation.

### Eval bar

A held-out set of probes scored by *the user* — manually, before any fine-tuning — that the fine-tuned judge has never seen. The fine-tuned judge wins only if:

1. Its agreement with the user's manual scores is higher than the base judge's, *and*
2. Its agreement with a third-party gold standard (e.g., scores from an independent LLM judge or a panel of human raters) is at least non-degraded.

Condition (2) rules out sycophancy. If a fine-tuned judge agrees more with the user but agrees less with the gold standard, ship the base judge.

**Realistic outcome:** condition (2) will sometimes fail. The team should be prepared to tell users "your judge adapter did not beat the base judge on accuracy; we're not deploying it." This is a product-design challenge as much as an engineering one.

### Pipeline (assuming the eval bar is met)

**Corpus.** `judge_call_log` rows for the user, restricted to probes where the user has expressed agreement or disagreement with the base judge. Each row becomes (probe_question, probe_answer, model_answer, judge_score, judge_reasoning) — a labeled grading example.

**Minimum corpus size.** ~500 graded examples. Below that, the adapter likely overfits; warn the user that more grading data is needed.

**Framework.** Same as §10 (PEFT or Unsloth, on-Spark only).

**Evaluation cadence.** Re-run the eval harness on every new adapter version. Surface eval scores in the UI. Make it possible for the user to revert to base judge with one click.

**Expected impact on existing checks.** If the per-user judge is more agreement-aligned with the user, CT02 (judge spot-recheck disagreement) may report higher disagreement rates than before, because the spot-recheck is currently done by the base judge. Either: do the spot-recheck with the same fine-tuned adapter (preserves CT02 semantics, weakens it as an independent oracle), or keep base judge for CT02 (preserves independence, surfaces disagreement). Recommendation: keep base judge for CT02 *because* it preserves the independence that gives CT02 its value.

---

## 12. Tenant isolation and security

**Adapter swap discipline.** A Spark hosts one base model in unified memory; LoRA adapters are loaded per request. The Spark service must:
- Validate the requesting tenant has access to the requested adapter (by adapter id signed from the API server).
- Never cache a previous tenant's adapter weights past the request.
- Keep base-model weights and per-request KV cache strictly separated.

Frameworks like vLLM with multi-LoRA support already do this; using a stock framework rather than rolling our own is the right call.

**Per-Spark API keys.** Each Spark has its own key, stored hashed in `sparks.api_key_hash`. Rotation is operator-driven (manual for v1; automated rotation deferred). A revoked key invalidates the Spark; clients fall back via the router.

**API server → Spark auth.** Bearer token (per-Spark API key). Rate limiting per-Spark, per-tenant (deferred to fleet phase, §15.5).

**Network topology options:**

- *Tailscale.* Easiest for BYO and small Innoculus fleets. Authenticated by Tailscale identity, encrypted by WireGuard. Recommendation for v1.
- *Cloudflare Tunnel.* Good if Sparks are behind NAT / consumer ISPs. Slightly more setup; works without exposing ports.
- *mTLS direct.* Highest performance, hardest to operate. Reserve for Innoculus-owned datacenter Sparks if they ever exist.

**Privacy: relic data becoming training data.** The current CT05 check scans probe text for PII (email, phone, SSN regex). Once probes flow into `judge_call_log` for fine-tuning corpora, the privacy surface grows:

- A user whose probes contain PII has that PII baked into a per-user adapter.
- Adapters are stored per-Spark; weights leaving the Spark (for backup, migration) carry the PII with them.
- Even without raw text, fine-tuned weights are known to leak training data in some regimes.

**Mitigations:**

- Tighten CT05 to be a hard fail before any judge call (currently it's verifier-side, not editor-side; data has already been sent to the judge by the time CT05 runs). Move PII scanning *upstream* of the judge call.
- Require explicit user consent before lifting their `judge_call_log` rows into a training corpus. Surface in the UI as a one-time prompt: "Use my probe history to fine-tune a personal judge?"
- Per-tenant isolation of adapter weights at rest. Adapters are per-user; cross-user reads must be impossible at the API and DB level.

**Daemon chat ephemerality (privacy positive).** As of HEAD, `daemon-chat.tsx` holds conversation state only in the React component; nothing is sent to a `daemon_chat_log` or any server-side table. Refreshing the page resets the conversation. This is good for privacy — no user-Daemon dialogue is ever at rest in the system. Worth preserving as the integration evolves; if the team later wants to enable per-user chat history, the privacy story changes and §11's consent surface needs to expand accordingly.

**Relic signing — current gap.** As of HEAD `a83669c`, the merged innoculation pipeline sets `signed_proof = "innoculation:${hash}"` rather than an HMAC (`pipeline.ts`, `runEditorVerifierCycle`). The standalone `numerical` and `cutoff_trace` paths both produce real HMACs via `signArtifact()`; the merge path skips that step. This is consequential for the DGX integration because the routing contract (§9) keys on `relic_id`. An unsigned relic id is forgeable, which means an attacker who can submit traffic to the API server could request inference under arbitrary `relic_id` values and select the corresponding adapter. Recommendation: replace the placeholder with a real HMAC keyed by `VERIFIER_SIGNING_KEY` over the merged artifact, before §15 Phase 3 ships. This is small (a few lines in `pipeline.ts`) and should be a prerequisite for relic-keyed routing.

**ToS update.** A consent surface and a ToS amendment are both required before §15 Phase 4 ships. Owner: Product.

---

## 13. Operational concerns

**Cold-start time.** Loading a 70B base model into Spark unified memory takes ~30–90s depending on quantization and storage path. LoRA adapter swap is sub-second. Strategy: keep one or two base models warm per Spark; route around the rest.

**Warm pool.** For Innoculus-owned Sparks: a small warm pool (1–2 Sparks always-on per popular base model) keeps p50 chat latency reasonable. Spillover routes to BYO if available, then to upstream OpenAI as ultimate fallback.

**Storage growth math.** A LoRA adapter for a 70B model at rank 16 is ~50–200 MB depending on layer coverage. Per relic × 3 versions retained × N relics is the Daemon adapter footprint; per user × 3 versions × M users is the judge adapter footprint. At 1k users × 3 judge versions × 100 MB = 300 GB. At 10k relics × 3 versions × 100 MB = 3 TB. Plan for object-storage growth in TB per year at scale; use lifecycle rules to cull older versions automatically.

**Retention.**

- *Adapters:* Latest N versions per (relic, user); older versions evicted. Default N=3.
- *Training runs:* Indefinite for audit purposes (small rows + eval logs only; weight artifacts collected via the adapter table).
- *Judge call log:* User-controlled. Default 1 year; users can opt to extend or purge. Required for the fine-tuning corpus.

**Observability.**

- Per training run: step-level losses, periodic eval scores, GPU utilization.
- Per inference request: spark_id, base_model, adapter_id, latency, tokens in/out, cost.
- Eval scores plotted over time per (relic, user) so regressions are visible.

**Failure modes and fallback.**

| Failure | Detection | Fallback |
|---|---|---|
| Spark unreachable | Healthcheck timeout / 5xx | Mark `unreachable`; router skips |
| Spark degraded (slow) | Latency budget exceeded | Mark `degraded`; router prefers others |
| Adapter weights missing | Spark-side 404 on adapter id | Fall back to base model; log; surface to user |
| Training run OOM | Spark-side OOM signal | Mark training run failed; user notified |
| Upstream OpenAI rate-limited (during fallback) | 429 from OpenAI | `chat()` retries once with backoff; if still failing, surface error |

---

## 14. Cost and billing model options

| Model | Pros | Cons | Best for |
|---|---|---|---|
| **Per-hour rental** | Predictable for users with steady workloads. Maps directly to Spark utilization. | Awkward for bursty users; requires explicit "start/stop." | Power users with long innoculation sessions |
| **Per-training-run** | Aligned with biggest-cost events. Easy to communicate. | Inference cost not captured separately. | Fine-tuning-heavy workflows |
| **Per-1k-tokens** | Familiar (matches OpenAI). Aligns with actual usage. | Requires per-request metering on the Spark. | Casual / chat-heavy users |
| **Hybrid: subscription + overage** | Predictable revenue + matches real usage. | More implementation work. | Most viable at scale |

**Recommendation:** Start with **per-hour rental** for Phase 1 (BYO doesn't need billing; Innoculus-fleet rentals are simple to explain and cap). Move to **hybrid subscription + token overage** in Phase 5 once metering is built and steady-state usage patterns are observable.

**Billing provider.** Stripe metered billing handles all four models. Decision deferred to product owner.

---

## 15. Phased delivery plan

### Phase 1 — Pluggable inference routing

**Goal:** Make `openai-client.ts` route through a resolver. No DGX yet.

**Scope:** Implement `routeInference()` (§9) with the fallback-only branch (resolves everything to upstream OpenAI). Wrap `chat()`. Pass `(user_id, relic_id, role)` from existing call sites. Tests confirm bit-for-bit behavioral equivalence with the current implementation when fallback is the only path.

**Dependencies:** None.

**Acceptance:** Existing test suite still passes. Router has unit tests covering its three role types. No user-visible change.

**Biggest risk:** Threading `user_id` through call sites that don't currently know about users (innoculation jobs are anonymous in v1). May need to add a placeholder user-id concept first.

### Phase 2 — BYO Spark protocol + judge hosting

**Goal:** A user can register a Spark and route their judge calls through it.

**Scope:** Spark-side service (Docker image: vLLM + auth shim). API endpoints for `/api/sparks` (§8). Router learns rule (3) from §9. Tailscale tunnel as primary network option. Per-Spark API keys.

**Dependencies:** Phase 1.

**Acceptance:** A test user with a registered Spark sees their judge calls hit the Spark (verified via Spark-side logs). Fallback to OpenAI works when the Spark is taken offline. CT02 still functions.

**Biggest risk:** Spark-side service maturity. vLLM is mature for inference but its multi-tenant auth story is thin; expect to write a small auth-proxy shim.

### Phase 3 — Per-relic Daemon support (retrieval first, optional fine-tuning)

**Goal:** Bound Daemon answers questions about its relic, ideally with relic-specific style.

**Scope:** Inject relic into bound-Daemon system prompt (retrieval-augmented baseline). Add `daemon_adapters` table and adapter pinning (§7, §8). Build the §10 eval harness. Optionally train one Daemon adapter end-to-end and evaluate against retrieval baseline.

**Dependencies:** Phase 2. **Pre-requisite:** the merged-innoculation `signed_proof` placeholder must be replaced with a real HMAC (see §12, "Relic signing — current gap") before relic-keyed routing rolls out, otherwise adapter selection is forgeable.

**Acceptance:** Retrieval baseline ships and works. Eval harness produces a reproducible score. **Decision gate:** if fine-tuned adapter does not beat retrieval, do not ship per-relic adapters (table remains, code path remains gated).

**Biggest risk:** The §10 concern — fine-tuning may not be worth the complexity. Phase 3 is structured to find this out cheaply.

### Phase 4 — Per-user judge persona

**Goal:** A user can fine-tune their own judge; if it beats the base judge on independent eval, deploy it.

**Scope:** `judge_call_log` table populated retroactively from existing `cutoff_artifacts.probe_results`. `judge_adapters` table. Training-run pipeline (§7, §8). The §11 eval harness with the gold-standard third-party check. Consent flow + ToS update (§12).

**Dependencies:** Phase 3 (eval harness reuse).

**Acceptance:** The eval bar in §11 passes for at least one test user. CT02 continues to use the base judge (independence preserved).

**Biggest risk:** The §11 structural concern — sycophancy is hard to rule out. If the eval harness can't distinguish accuracy from agreement, this phase ships disabled or with a heavy "experimental" warning.

### Phase 5 — Innoculus-hosted fleet + billing

**Goal:** Users without their own Spark can rent compute.

**Scope:** Innoculus operates ≥2 Sparks. Rentals (§7, §8). Stripe metered billing. Per-tenant rate limiting. Warm pool strategy.

**Dependencies:** Phase 2 (Sparks register; Innoculus's are just registered as Innoculus-owned).

**Acceptance:** A user without their own Spark can complete an innoculation against a hosted Spark, and gets a Stripe invoice.

**Biggest risk:** Operational. Multi-day uptime on a small fleet without on-call coverage will hurt.

### Phase 6 — Multi-tenant scheduling

**Goal:** Multiple users share a Spark efficiently.

**Scope:** Request scheduler. Per-tenant fairness. Adapter cache tuning. Latency SLO.

**Dependencies:** Phase 5.

**Acceptance:** Three concurrent tenants see a documented latency SLO maintained.

**Biggest risk:** Scheduling regressions can degrade everyone simultaneously. Build with a safety hatch: scheduler can be disabled, falling back to first-come-first-served.

---

## 16. Open questions (decisions owed by product owner)

These are explicit asks for decisions before the corresponding phase can start.

1. **Base model family.** Llama 3.x? Qwen 2.5? Mistral? Trade-off: license terms, FP4 readiness, instruction-tuning quality. *Owed before:* Phase 2.
2. **Fine-tuning framework.** PEFT / Unsloth / NeMo / something else. *Owed before:* Phase 3 fine-tuning subtask.
3. **Billing provider.** Stripe metered the assumption; alternatives (Lago, Orb) not evaluated. *Owed before:* Phase 5.
4. **Network topology default.** Tailscale assumed for v1; need confirmation. *Owed before:* Phase 2.
5. **Retention policy for `judge_call_log`.** 1-year default needs product approval. Affects ToS. *Owed before:* Phase 4.
6. **ToS update wording.** Specifically the consent surface for using probes as training data. *Owed before:* Phase 4.
7. **Make Spectral phase model-conditional?** §3 caveat. If yes, work goes in front of Phase 1. If no, document as deliberate. *Owed before:* Phase 1.
8. **Decision criterion for shipping Daemon adapters.** §10 recommends a 5pp eval lift over retrieval; team needs to confirm or revise. *Owed before:* Phase 3 decision gate.
9. **Decision criterion for shipping judge adapters.** §11 recommends gold-standard-non-degradation. Same. *Owed before:* Phase 4 decision gate.
10. **Confirm the relic-signing fix lands before Phase 3.** §12 flags that the merged-innoculation `signed_proof` is a string placeholder rather than an HMAC. Trivial to fix; needs to be sequenced before relic-keyed routing. *Owed before:* Phase 3.

---

## Appendix A — Glossary

- **Relic** — A sealed, signed artifact produced by a successful innoculation. Contains both the Spectral phase's numerical diagnostics and the Speculative phase's cutoff trace, plus a unified verdict and an HMAC signature. Stored in `job_artifacts` rows with `kind = "innoculation"`.
- **Innoculation** — A full audit run: both phases executed, merged, and verified into a relic.
- **Spectral phase** — The numerical pipeline (kernels, lattice sums, Bessel oracle). Job kind `numerical`. Produces self-force-style diagnostics.
- **Speculative phase** — The cutoff-trace pipeline (probes, judge, logistic changepoint). Job kind `cutoff_trace`. Produces an estimated knowledge-cutoff month with a 95% CI.
- **Cutoff trace** — Synonym for Speculative phase output.
- **Daemon** — The chat persona of Innoculus. *Standalone* (unbound, on the splash page) or *bound* (conditioned on a specific relic). Currently runs on `chat()` calls to a configured base model with a structured system prompt.
- **Judge** — The LLM that grades probe responses. Configurable per innoculation (`judge_model`, `judge_temperature`).
- **Probe** — A `(question, answer, date)` tuple supplied by the user for the Speculative phase. The model under audit is asked the question; the judge grades the model's answer against the ground truth.
- **Adapter** — A LoRA / QLoRA weight-delta file applied on top of a base model at inference time. Daemon adapters are per-relic; judge adapters are per-user.
- **Rental** — A time-bounded grant of an Innoculus-owned Spark to a user. Billed per hour (Phase 1) or via subscription + overage (Phase 5+).
- **BYO Spark** — A Spark owned by the user, registered with Innoculus, used only for that user's workloads.

---

## Appendix B — File map

Existing files referenced in this spec, with one-line purposes. An LLM expanding any section can request the full contents of these files for grounding.

**API server:**

- `artifacts/api-server/src/routes/jobs.ts` — Job lifecycle endpoints (create, list, get, status, artifact, work, verify, verdict, retry).
- `artifacts/api-server/src/routes/daemon.ts` — Standalone Daemon endpoint (`POST /api/daemon/messages`); rate-limited public chat.
- `artifacts/api-server/src/workers/pipeline.ts` — Pipeline orchestration; advances jobs through lifecycle states.
- `artifacts/api-server/src/workers/editor.ts` — Spectral-phase Editor; numerical pipeline including Warburg oracle.
- `artifacts/api-server/src/workers/verifier.ts` — Spectral-phase Verifier; CHK01–CHK08, plus shared utilities (`computeArtifactHash`, `signArtifact`).
- `artifacts/api-server/src/workers/cutoff-editor.ts` — Speculative-phase Editor; probes + judge calls + logistic changepoint fit.
- `artifacts/api-server/src/workers/cutoff-verifier.ts` — Speculative-phase Verifier; CT02 (judge recheck), CT03 (monotonicity), CT04 (coverage), CT05 (PII).
- `artifacts/api-server/src/lib/openai-client.ts` — Single LLM chokepoint; exports `chat()`. **Integration point for the inference router.**
- `artifacts/api-server/src/lib/warburg.ts` — Closed-form Bessel oracle; pure math.
- `artifacts/api-server/src/lib/warburg-self-test.ts` — Boot-time self-test for the math module.

**Frontend:**

- `artifacts/innoculus-web/src/pages/submit.tsx` — Innoculation submission form (target/judge models, latency, probes). Note `SPECTRAL_DEFAULTS` constant — see §3.
- `artifacts/innoculus-web/src/pages/job-detail.tsx` — Job results: stepper, unified+sub verdicts, diagnostics, relic viewer (tabs: Speculative / Spectral / Raw), Daemon chat embed.
- `artifacts/innoculus-web/src/components/daemon-chat.tsx` — Bound Daemon chat UI for `POST /api/jobs/:id/daemon/messages`. Includes a `DaemonOrb` visualizer and `useDaemonVoice` audio playback (TTS clip plays on each successful response, orb pulses with amplitude). Conversation state held only in component state — not persisted server-side; refreshing the page resets it.

**Database schema:**

- `lib/db/src/schema/jobs.ts` — `jobs` table; `kind` enum (`numerical` | `cutoff_trace` | `innoculation`); policy config interfaces.
- `lib/db/src/schema/job-artifacts.ts` — `job_artifacts` table; payload interfaces for both phases plus the merged `InnoculationArtifactPayload`.
- `lib/db/src/schema/job-diagnostics.ts` — Per-artifact diagnostics: spectral metrics, verdict, namespaced issues.

**API contract:**

- `lib/api-spec/openapi.yaml` — Source of truth; codegen target.
- `lib/api-client-react/` — Orval-generated React Query hooks consumed by the frontend.

---

*End of spec.*
