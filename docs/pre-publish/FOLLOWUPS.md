# Pre-Publish Follow-Ups — rev-1 findings 8–12

Reviewer (Claude Code) raised five additional items beyond the seven blockers
resolved in `REVIEW.md`. These are tracked here rather than absorbed silently.
Status as of 2026-05-04, working tree on top of `7c94cd9`.

The Replit project-task follow-up channel (`proposeFollowUpTasks`) is
one-shot per assigned project task and was already consumed earlier in this
project for the cutoff-tracer task, so this file is the authoritative tracker
for items 8–12 until the next planning cycle.

---

## #8 — Silent NaN-skip in residual loop ✅ Resolved inline

**Finding.** `computeWarburgOracle` skipped dual-index modes where `fOracle`
was non-finite with no count. If the oracle silently excluded a large
fraction of modes, the residual was computed over a small subset and CHK08
would underreport drift.

**Resolution.** `artifacts/api-server/src/workers/editor.ts` now counts both
`non_finite_skips` and `zero_oracle_modes` against `total_nonzero_modes` and
emits a `logger.warn` line including the skip fraction whenever any mode is
skipped:

```
"Warburg oracle skipped modes during residual computation — CHK08 may
underreport drift"
```

We deliberately keep this as a log line rather than a per-job diagnostic
field — the rev-2 surgery was about removing dead/redundant per-job state,
and a log signal is the right shape for "rare unexpected condition we want
visibility on."

**Done.**

---

## #9 — Sigma default coupling ✅ Resolved inline (verification + comment)

**Finding.** Oracle defaulted `sigma` to `1.0` if unset; reviewer wanted to
verify the numerical Editor used the same default, otherwise sigma-less jobs
would produce a misleadingly large residual.

**Resolution.** Verified — all three call sites in
`artifacts/api-server/src/workers/editor.ts` use `kernel.sigma ?? 1.0`:

| Line | Site                                | Default     |
|------|--------------------------------------|-------------|
| 33   | `buildK0` (numerical k₀)             | `?? 1.0` ✅ |
| 132  | spectral path                        | `?? 1.0` ✅ |
| 437  | `computeWarburgOracle` (this work)   | `?? 1.0` ✅ |

Added a comment at the oracle site warning future editors that the three
defaults are coupled and must move together.

**Done.**

---

## #10 — Large-z underflow risk in K_ν ⚠️ Partially mitigated

**Finding.** `K_ν(z) ~ √(π/(2z))·e^(−z)` underflows to 0 around `z ≈ 745`
in float64. If `2√(AB)` reaches that range on real jobs, the residual
compares 0 against 0 and CHK08 silently passes regardless of correctness.
Whether this is reachable depends on real-world `μᵀQ⁻¹μ` magnitudes.

**This-turn mitigation.** The skip-counter from finding #8 catches this
case: when K_ν underflows to 0 we hit the `fOracle === 0` branch (which
contributes 0 to both `sumDiff2` and `sumF2`), and the warn line surfaces
the count. A follow-up turn should also add the line to the README §8c
risk discussion. Added to risk table in `REVIEW.md`.

**Open work.** Once we have production telemetry on real `μᵀQ⁻¹μ`
magnitudes, decide whether to:

1. Switch to log-space accumulation in the oracle (compare `log fNum` vs
   `log fOracle` so the comparison stays meaningful even when both
   underflow to 0); or
2. Hard-fail CHK08 (rather than warn) when the underflow-fraction exceeds
   some threshold.

**Owner.** Numerical pipeline team. **Priority.** Medium — depends on
whether real jobs hit the regime.

---

## #11 — Supervisor-level concerns ⏸ Out of scope (separate work stream)

Reviewer flagged four orchestration / supervisor concerns that are not
touched by the Warburg work and need their own dedicated task:

1. **Head-of-line blocking** in the single-threaded job loop — one slow job
   stalls the queue.
2. **No attempt counter on remediation** — a remediation can loop
   indefinitely without observability.
3. **Idempotency on duplicate `job_id` with different params** — the
   second submission silently overwrites; should reject or version.
4. **HMAC labelled as "signature" in docs** — HMACs are not signatures
   (no public-key verifiability); the README and OpenAPI use the wrong
   word.

**Owner.** Pipeline / infra team. **Priority.** Medium-high; (1) and (3)
affect production fairness / correctness, (2) and (4) affect operability /
docs accuracy.

**Not done — explicitly out of scope for this rev-2 cleanup.**

---

## #12 — "Unified Warburg theorem" naming ⏸ Future cleanup

The actual identity in `besselIntegralClosedForm` is the standard integral
representation of K_ν (e.g. Gradshteyn & Ryzhik 3.471.9), not a
non-standard "unified Warburg theorem." Naming will confuse external
readers.

**Suggested rename.** "Bessel-form gaussian oracle" (or
"closed-form gaussian oracle"). Affects:

- `artifacts/api-server/src/lib/warburg.ts` (file name + module docstring)
- `artifacts/api-server/src/lib/warburg-self-test.ts` (file name + module
  docstring)
- README §8c heading and prose
- `closed_form_residual` field name is already neutral ✅
- `warburg_residual_tol` policy field name — would be a breaking API
  rename; keep the `warburg_` prefix for compatibility, accept the naming
  drift on the wire.

**Owner.** Numerical pipeline team. **Priority.** Low — purely cosmetic;
no behaviour change. Bundle with the next material change to the oracle
module so the rename ships with real work, not as a churn-only commit.

**Not done — explicit defer.**
