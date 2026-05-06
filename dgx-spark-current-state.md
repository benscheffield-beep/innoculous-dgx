# DGX Spark + Innoculus Integration — Current State

**Date:** 2026-05-06
**Audience:** Replit's coding agent / next Claude Code session
**Purpose:** Bring you up to speed on what's installed, configured, and pending without requiring access to the prior debugging session's chat history.

This document is *state*, not a log. It tells you what *is*, with enough reasoning to understand why. Companion to `docs/dgx-innoculus-spec.md` (which is forward-looking design); read this for what's actually deployed today.

---

## 1. Status in one paragraph

Innoculus's Phase 1 inference router (per `docs/dgx-innoculus-spec.md` §15 Phase 1) has shipped on the Replit side. A DGX Spark is set up to host the inference layer locally, reachable from Replit over a public Tailscale Funnel URL with bearer-token auth. The end-to-end network path is verified: 200 with auth, 401 without, ~189 ms warm inference roundtrip on Qwen 2.5 7B Instruct via Blackwell GPU. Two items remain before Phase 1 verification is complete: (1) update Replit's two `AI_INTEGRATIONS_OPENAI_*` secrets to point at the Spark, and (2) submit a real innoculation through the UI as a smoke test.

---

## 2. Replit-side changes (already shipped this session)

### 2.1 Phase 1 inference router

**New file:** `artifacts/api-server/src/lib/inference-router.ts`

Exports `RouteRequest`, `RouteResolution`, and `routeInference()`. Phase 1 implementation: returns a fallback resolution that mirrors the existing `AI_INTEGRATIONS_OPENAI_*` env vars. Returns `spark_id: null` (no per-Spark routing yet — that's Phase 2).

`RouteRequest` shape:
```ts
{
  user_id: string;       // currently always "anonymous" (auth deferred)
  relic_id: string | null;  // job_artifacts.id for bound Daemon, null otherwise
  role: "target" | "judge" | "daemon";
  preferred_spark_id?: string;
  budget_cents_remaining?: number;
}
```

**Modified files:**

- `artifacts/api-server/src/lib/openai-client.ts` — imports/re-exports `RouteRequest`. `chat()` now takes `ctx: RouteRequest`, calls `routeInference(ctx)`, uses `route.model || opts.model` for model resolution.

  *Note:* The `route.model || opts.model` precedence is worth verifying. In Phase 1 fallback mode, `route.model` will return whatever's in the env-configured base URL's default model. If `route.model` always wins over `opts.model`, callers like `cutoff-editor.ts` lose the ability to select target/judge models per innoculation (the Submit form lets users type model names). The right semantics is probably `opts.model || route.model` — caller's choice wins, router fills in defaults. **Confirm the diff matches the right precedence before sustained use.**

- `artifacts/api-server/src/workers/cutoff-editor.ts` — `targetCtx` and `judgeCtx` constructed once per innoculation, both threaded with `role: "target"` and `role: "judge"` respectively, `relic_id: null`.

- `artifacts/api-server/src/workers/cutoff-verifier.ts` — CT02 spot-recheck call threaded with `role: "judge"`, `relic_id: null`.

- `artifacts/api-server/src/routes/daemon.ts` — standalone (unbound) Daemon call threaded with `role: "daemon"`, `relic_id: null`.

- `artifacts/api-server/src/routes/jobs.ts` — bound Daemon call threaded with `role: "daemon"`, `relic_id: art.id` (the artifact ID, which for innoculation jobs is the merged-relic ID).

### 2.2 HMAC seal fix

**File:** `artifacts/api-server/src/workers/pipeline.ts`

Previously, `runEditorVerifierCycle` set `signed_proof = "innoculation:${hash}"` for innoculation jobs — a placeholder string, not an HMAC. The "Signed" badge in `job-detail.tsx` (gated on `signed_proof` truthiness) rendered as truthy without backing.

Now: `runInnoculationCycle` returns `{ artifact, mergedMetrics }` where `mergedMetrics = { numerical, cutoff_trace }` carries each phase's `recomputed_metrics`. The caller invokes `signArtifact(hash, mergedMetrics, verdict)` — the same HMAC-SHA256 path used by the standalone numerical and cutoff_trace verifiers. The "Signed" badge is now backed by a real HMAC for innoculation relics.

### 2.3 Test status

92/92 api-server tests pass on the post-router code. `jobs.test.ts` fails only on `DATABASE_URL` not being set, identical to the pre-change baseline (not a regression).

If you see a different number elsewhere in the repo or chat history, note: 132/132 was the count after the rev-2 Warburg work. The current count is 92/92 (smaller because of test scope, not regression — verify by running locally if uncertain).

---

## 3. Spark-side state

### 3.1 Hardware

- DGX Spark (NVIDIA workstation), GB10 Blackwell GPU, ARM64 CPU
- ~128 GB unified memory (no separate VRAM/system RAM split)
- CUDA capability 12.1 — PyTorch in current vLLM image only formally supports 8.0–12.0; emits a warning at startup but works in practice. Worth knowing the toolchain is at the edge of its support window.

### 3.2 OS environment

- Linux, ARM64
- User: `siliconreckoner`, hostname `spark-f032`
- Snap, Docker, systemd, Tailscale all available and used

### 3.3 Services running

#### vLLM (Docker, GPU-bound) — primary inference target for Innoculus

| Property | Value |
|---|---|
| Container name | `vllm-innoculus` |
| Image | `vllm/vllm-openai:latest` |
| Host port binding | `127.0.0.1:8001` → container `8000` (loopback only on host) |
| Model | `Qwen/Qwen2.5-7B-Instruct` |
| Args | `--max-model-len 8192 --gpu-memory-utilization 0.3` |
| Restart policy | `unless-stopped` |
| HF cache mount | `~/.cache/huggingface:/root/.cache/huggingface` |
| Status | Running. Cold-start inference ~20s, warm ~189ms. |

#### vLLM (Docker, GPU-bound) — secondary, currently STOPPED

| Property | Value |
|---|---|
| Container name | `vllm-coder` |
| Image | `vllm/vllm-openai:latest` |
| Host port binding | `0.0.0.0:8000` → container `8000` (NOT loopback-bound) |
| Model | `Qwen/Qwen2.5-Coder-32B-Instruct` |
| Args | `--max-model-len 32768` |
| Status | **Stopped manually** to free GPU memory. Restart with `sudo docker start vllm-coder`. |

The user runs unrelated experiments on this container. At default config it claims ~63 GB of unified memory, leaving insufficient room for `vllm-innoculus` to start. To run both simultaneously, both need explicit `--gpu-memory-utilization` constraints (Coder ~0.55, Innoculus ~0.30). For now they run one at a time, with `vllm-coder` paused while Innoculus verification happens.

#### Caddy (systemd) — auth gateway

- Service: `caddy.service` (enabled, running)
- Config file: `/etc/caddy/Caddyfile`
- Bound to: `127.0.0.1:8080` (loopback only)
- Forwards authorized requests to: `127.0.0.1:8001` (vllm-innoculus)
- Auth: `Authorization: Bearer <key>` exact-match against value in Caddyfile
- Returns 401 to unauthenticated requests

Current Caddyfile structure (key redacted):

```
{
    auto_https off
}

:8080 {
    bind 127.0.0.1
    @authorized header Authorization "Bearer <REDACTED>"
    handle @authorized {
        reverse_proxy 127.0.0.1:8001
    }
    respond 401
}
```

**Three non-obvious config choices that matter:**

1. The global `{ auto_https off }` directive prevents Caddy from auto-upgrading bare site addresses to HTTPS. Without it, Caddy interprets `127.0.0.1:8080` as a domain to manage TLS for, which causes "Client sent HTTP to HTTPS server" 400s on plaintext loopback traffic.

2. The site address is `:8080` (bare port, no host filter). Earlier configs used `http://127.0.0.1:8080` which sets `127.0.0.1` as the virtual-host filter — but Tailscale Funnel forwards requests with `Host: spark-f032.tailf000f9.ts.net`, which doesn't match, causing the auth matcher to never run and unauthenticated requests to bypass the auth gate. The bare `:8080` form matches any `Host`.

3. `bind 127.0.0.1` keeps the listener on loopback only, so the Spark's LAN cannot bypass the Funnel and hit Caddy directly.

#### Tailscale (system) — public exposure

- Tailnet name: `tailf000f9`
- Spark hostname in tailnet: `spark-f032`
- Public URL via Funnel: `https://spark-f032.tailf000f9.ts.net/`
- Funnel command (used to start): `sudo tailscale funnel --bg --https=443 http://127.0.0.1:8080`

Verify with `sudo tailscale serve status`. Should show `Funnel on` with proxy line `http://127.0.0.1:8080`.

The end-to-end chain:

```
public URL (HTTPS:443)
  → Tailscale Funnel edge (TLS terminates)
  → tailnet (encrypted, WireGuard)
  → Spark Tailscale serve at :443 in tailnet
  → forwards to localhost:8080
  → Caddy at 127.0.0.1:8080 (bearer-token auth gate)
  → forwards to localhost:8001
  → vLLM Docker container (Qwen 2.5 7B on Blackwell GPU)
  → response returns the reverse path
```

Total warm-path latency: ~189 ms for a 10-token completion (measured locally from the Spark, hitting the public URL — accounts for TLS, Funnel hop, tailnet hop, Caddy auth check, vLLM inference, and reverse path).

#### Ollama (snap) — running but not in use

- Snap package: `ollama`
- Listening on: `127.0.0.1:11434`
- Models pulled: `llama3.1:8b-instruct-q4_K_M`, `qwen2.5-coder:32b`
- CPU-bound on this Spark (snap sandboxing prevents GPU passthrough)

Was the initial inference target before the vLLM container approach was chosen. Now irrelevant to the pipeline. Can be stopped with `sudo snap stop ollama` to reclaim RAM if needed.

---

## 4. Action items

### 4.1 Immediate: update Replit secrets

Two existing Replit secrets need to point at the Spark instead of upstream OpenAI:

| Secret | New value |
|---|---|
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | `https://spark-f032.tailf000f9.ts.net/v1` (with `/v1` suffix, no trailing slash) |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | The bearer token currently in the Caddyfile |

**Important:** The bearer token value lives in the user's password manager. The user will paste it directly into Replit's Secrets UI. **Do not request the value via chat.** The agent should see only that the secrets are updated, not their values.

After both are saved, restart the API server workflow.

### 4.2 Smoke test (after secrets update)

User submits a small innoculation through the UI:

- Target Model: `Qwen/Qwen2.5-7B-Instruct`
- Judge Model: `Qwen/Qwen2.5-7B-Instruct`
- Judge Temperature: `0`
- Latency: λ=1.0, δ=0, Tnow=1.0
- 3 probes (any factual questions with dates)

Expected: job completes successfully with verdict `pass` or `warn`. On the Spark, `sudo docker logs -f vllm-innoculus` shows ~9 incoming requests (3 target probes, 3 judge grades, ~3 CT02 spot-rechecks). After the relic seals, opening the Daemon chat and sending a message should produce a fast response routed through the same path.

### 4.3 Possible failure modes for the smoke test

- **Job hangs / times out**: Replit may not be reaching the Spark. Diagnostic from a Replit shell:
  ```
  curl -v --max-time 10 https://spark-f032.tailf000f9.ts.net/v1/models \
    -H "Authorization: Bearer $AI_INTEGRATIONS_OPENAI_API_KEY"
  ```
  Should return 200. If it hangs or 401s, the Spark URL or key is wrong on Replit.

- **All judge scores are 0**: Qwen 2.5 7B may preamble its JSON output ("Sure! Here is my evaluation: {…}"), breaking `parseJudgeResponse` in `cutoff-editor.ts`. The fallback path returns score 0 for unparseable, which collapses CT02. Mitigation: tighten the judge system prompt — repeat "Output only JSON. No explanation. No preamble." and possibly add a single-shot example.

- **Cold-start latency on first request**: first request after a Spark reboot or vLLM restart triggers CUDA graph capture and may take 15-30s. Subsequent requests are sub-200ms.

- **Funnel down**: Tailscale Funnel quick configs sometimes drift. On the Spark, `sudo tailscale serve status` should show `Funnel on` with proxy at `http://127.0.0.1:8080`. If absent, restart with `sudo tailscale funnel --bg --https=443 http://127.0.0.1:8080`.

---

## 5. Outstanding work / carry-forwards

These were flagged in earlier reviews and remain open. None block Phase 1 verification.

### 5.1 From the Phase 1 router work

- **Verify `route.model || opts.model` precedence** in `openai-client.ts`. See §2.1 above. If router's model wins over caller's, the Submit form's per-job target/judge model selection breaks.

### 5.2 From the rev-2 Warburg review

- **Silent NaN-skip count in residual loop**: `computeWarburgOracle` skips dual-index modes where the oracle returns NaN with no count logged. Add a counter to diagnostics or a debug log.
- **Sigma default coupling**: Editor and oracle should share the gaussian-kernel sigma default to avoid misleading residuals on sigma-omitted jobs.
- **Large-z underflow risk in CHK08**: For `2√(AB) > ~745`, `K_ν(z)` underflows in float64 and the residual compares 0 to 0, silently passing.
- **`besselK` not in startup self-test**: Phase 5 covers `jacobiEigen`, but `besselK` (the most-used Bessel function in the per-job path) isn't asserted at boot. Add a one-line check.
- **"Unified Warburg theorem" naming**: The actual identity is the standard K_ν integral representation (Gradshteyn & Ryzhik 3.471.9). Worth renaming the module (e.g. `bessel-form-gaussian-oracle`) at a future cleanup — non-standard naming will confuse external readers.

### 5.3 From the design doc (§15)

- **Phase 2**: Spark registration model. Currently a single hardcoded Funnel URL via env vars. Phase 2 introduces the BYO Spark protocol and `/api/sparks` endpoints.
- **Phase 3**: Per-relic Daemon LoRA adapters. Note: §10 of the design doc recommends shipping retrieval-augmented system prompts first and only fine-tuning if retrieval can't carry the use case. Also: `daemon-chat.tsx` does not persist conversations — the corpus for any per-relic fine-tuning must be synthetically generated.
- **Phase 4**: Per-user judge persona adapters. Note: §11 of the design doc gates this on a gold-standard non-degradation eval criterion to rule out sycophancy.
- **Phase 5**: Hosted fleet + billing.
- **Phase 6**: Multi-tenant scheduling.

### 5.4 System-level concerns

- **Pipeline head-of-line blocking** (carry-forward from earlier reviews): `runPipeline` blocks on each job's editor+verifier cycle synchronously. `retryPipeline` fires-and-forgets via `setImmediate`. No persistent queue — restart loses in-flight jobs. The DGX integration adds latency-variable network hops to every LLM call, which makes per-job duration more variable and the head-of-line blocking more visible. Track in `replit.md` Gotchas; address before Phase 5 fleet ops.

- **HMAC verification at Daemon chat time**: The bound Daemon endpoint trusts the `signed_proof` field stored in the database — it doesn't re-verify the HMAC before constructing the system prompt. Closes a gap that becomes load-bearing in Phase 3 when `relic_id` drives adapter selection.

### 5.5 Network/security migration

- **Move from Tailscale Funnel to Cloudflare named tunnel**: Tailscale Funnel is bandwidth-capped at 1 GB/month on the personal/free tier. Fine for Phase 1 verification; not viable for sustained traffic. Migration requires:
  1. A Cloudflare account (user has none yet).
  2. A domain (~$10/year for `.dev` via Cloudflare's at-cost registrar).
  3. Named tunnel setup (`cloudflared tunnel create`, DNS, etc.).
  4. `cloudflared` as a systemd service on the Spark.
  5. Update Replit's `AI_INTEGRATIONS_OPENAI_BASE_URL` to the new domain.

  Estimated ~30 minutes once the user has Cloudflare account + domain. This is on the path to §15 Phase 2.

---

## 6. Security state

### 6.1 Bearer token rotations during this session

Four bearer tokens were generated. The first three got exposed in chat (via paste accidents while debugging) and were rotated. The fourth is current:

| # | Status | Location |
|---|---|---|
| 1 | Dead | (was in chat) |
| 2 | Dead | (was in chat) |
| 3 | Dead | (was in chat) |
| 4 | **Current** | `/etc/caddy/Caddyfile` and user's password manager |

Tokens 1-3 are dead — they don't match the Caddyfile and would 401. The fourth was generated after token 3 was exposed, was never pasted into chat, and lives only in the two intended places.

### 6.2 Trust boundaries

- **Public**: `https://spark-f032.tailf000f9.ts.net` is reachable from the internet. Anyone who finds the URL can connect; the bearer token is the only barrier.
- **Tailnet hop**: WireGuard-encrypted between Funnel edge and Spark.
- **Spark loopback**: plaintext HTTP between Tailscale serve, Caddy, and vLLM. Acceptable because nothing else has loopback access on a single-tenant box.
- **Caddy is bound to 127.0.0.1**: the Spark's LAN cannot bypass the Funnel and hit Caddy directly.

### 6.3 Not currently protected

- **No application-level rate limiting on the Spark**: Caddy doesn't rate-limit; a leaked key plus a public URL plus an unbounded GPU is a budget-burn risk. Mitigate with Caddy `rate_limit` directive or per-tenant limits in the inference router.
- **No concurrent-request cap**: vLLM accepts requests until OOM; a flood pattern can exhaust GPU memory and crash the container.
- **No request signing beyond bearer auth**: a body-tamper would not be detected. Probably fine while Innoculus is single-tenant; matters in Phase 5+.
- **No audit log of bearer token usage**: who hit the URL, when, with what payload.

---

## 7. Files and configs to reference

If the agent needs to dig into Spark-side details, these are the relevant local paths (on the Spark, accessible via SSH as `siliconreckoner`):

| Path / command | Purpose |
|---|---|
| `/etc/caddy/Caddyfile` | Caddy config — contains the bearer token |
| `~/.cache/huggingface/` | vLLM model cache (Qwen 2.5 7B and any other models pulled) |
| `sudo docker ps -a` | List of containers (vllm-innoculus running, vllm-coder stopped) |
| `sudo docker logs vllm-innoculus` | vLLM startup and request logs |
| `sudo journalctl -u caddy --no-pager` | Caddy logs |
| `sudo tailscale serve status` | Tailscale Funnel state |
| `nvidia-smi` | GPU and processes (note: Memory-Usage shows "Not Supported" because of unified memory — that's expected, not broken) |

The Replit-side files are unchanged from what's in the git repo as of the post-Phase-1 commit. No additional local-only state on Replit to know about beyond the secrets being updated.

---

## 8. What this document is not

- Not a chronological log of the debugging session. State only.
- Not a replacement for `docs/dgx-innoculus-spec.md`. That doc is forward-looking design (Phase 1-6 phasing, target architecture). This doc is current-deployment state.
- Not a security audit. §6 captures the high-level trust boundaries; a real audit before Phase 5 would dig further.
- Not authoritative on code that hasn't been re-verified by the agent. The §2 changes were reported as shipped; the agent should `git log` and read the actual code to confirm.

---

*End of state document.*
