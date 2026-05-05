import { Router } from "express";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import {
  db,
  jobsTable,
  jobArtifactsTable,
  type InnoculationArtifactPayload,
  type JobDescriptor,
  type PolicyConfig,
} from "@workspace/db";
import { logger } from "../lib/logger.js";

/** Hard-gate dev routes off in production. The router is still importable
 *  (so route registration stays declarative) but the handler short-circuits
 *  with 404 before doing any work. Belt-and-suspenders alongside the
 *  conditional mount in routes/index.ts. */
const PRODUCTION_GUARD_ENABLED = process.env["NODE_ENV"] === "production";

/**
 * Developer-only routes for exercising downstream UI without running the full
 * Spectral + Speculative pipeline. Currently exposes a single endpoint that
 * synthesises a sealed `innoculation` relic so the Daemon chat (and its voice
 * + orb wiring) can be tested in seconds rather than minutes.
 *
 * No auth/gating: this stack is a single-tenant developer environment. If
 * Innoculus ever ships multi-tenant, this router should be conditionally
 * mounted only when `NODE_ENV !== "production"` (or behind an admin check).
 */
const router = Router();

function buildSyntheticInnoculationPayload(): InnoculationArtifactPayload {
  return {
    kind: "innoculation",
    verdict: "pass",
    sub_verdicts: { numerical: "pass", cutoff_trace: "pass" },
    numerical: {
      kind: "numerical",
      dual_indices: [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ],
      F: { "0,0": 1.0, "1,0": 0.5, "-1,0": 0.5, "0,1": 0.3, "0,-1": 0.3 },
      S: { "0,0": 0.95, "1,0": 0.42, "-1,0": 0.42, "0,1": 0.28, "0,-1": 0.28 },
      Phi_coeffs: [1.0, 0.5, 0.25, 0.125],
      R_coeffs: [0.95, 0.42, 0.18, 0.09],
      U_meta: {
        basis: [
          [1, 0],
          [0, 1],
        ],
        eigenvalues: [1.0, 0.85],
      },
      diagnostics: {
        spectral_radius: 0.42,
        cond_I_minus_G: 18.5,
        dual_truncation_error: 1.2e-7,
        spectral_tail_error: 4.6e-8,
        closed_form_residual: 2.1e-9,
        warburg_nu: 0.5,
      },
    },
    cutoff_trace: {
      kind: "cutoff_trace",
      model: "synthetic-target-model",
      judge_model: "synthetic-judge-model",
      probe_results: [
        {
          question: "Who won the 2023 Nobel Peace Prize?",
          answer: "Narges Mohammadi",
          date: "2023-10",
          model_answer: "Narges Mohammadi",
          judge_score: 1.0,
          judge_reasoning: "Exact match.",
        },
        {
          question: "What is the capital of France?",
          answer: "Paris",
          date: "2020-01",
          model_answer: "Paris",
          judge_score: 1.0,
          judge_reasoning: "Trivial recall.",
        },
        {
          question: "Synthetic future probe",
          answer: "unknown",
          date: "2025-06",
          model_answer: "I am not certain.",
          judge_score: 0.2,
          judge_reasoning: "Past cutoff.",
        },
      ],
      monthly_aggregates: [
        { month: "2020-01", n: 1, knew_rate: 1.0 },
        { month: "2023-10", n: 1, knew_rate: 1.0 },
        { month: "2025-06", n: 1, knew_rate: 0.2 },
      ],
      cutoff_estimate: {
        month: "2024-04",
        ci_low: "2024-02",
        ci_high: "2024-06",
        fit_quality: 0.87,
      },
    },
  };
}

router.post("/dev/daemon-test-relic", async (_req, res) => {
  if (PRODUCTION_GUARD_ENABLED) {
    res.status(404).json({ error: "not_found", message: "Not available in production" });
    return;
  }

  // The descriptor on `kernelParams` is normally consumed by the pipeline
  // (which we're bypassing) — store a minimal but plausible placeholder so
  // the row satisfies NOT NULL and any future inspector still sees sane
  // shape data. The prompt builder does not read this field.
  const descriptor = {
    kind: "innoculation",
    note: "Synthetic relic created via /dev/daemon-test-relic for daemon-chat smoke testing.",
  } as unknown as JobDescriptor;

  // Policy thresholds the Daemon prompt builder reads; using the defaults
  // documented in replit.md so the Daemon's self-introspection sounds
  // representative of a real run.
  const policy: PolicyConfig = {
    spectral_radius_max: 0.95,
    cond_limit: 1e6,
    dual_error_tol: 1e-6,
    spectral_tail_tol: 1e-6,
    judge_disagreement_max: 0.2,
    min_probes_per_month: 1,
    min_recheck_count: 1,
    warburg_residual_tol: 1e-6,
  };

  try {
    // All three writes (job insert, artifact insert, job.currentArtifactId
    // update) run in a single transaction so a partial failure can't strand
    // a `complete` job with no relic — or an artifact with no parent
    // back-reference — in the DB.
    const jobId = await db.transaction(async (tx) => {
      const [job] = await tx
        .insert(jobsTable)
        .values({
          kind: "innoculation",
          status: "complete",
          kernelParams: descriptor,
          policyConfig: policy,
        })
        .returning();
      if (!job) throw new Error("Failed to insert job row");

      const payload = buildSyntheticInnoculationPayload();
      const hash = crypto
        .createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex");

      const [art] = await tx
        .insert(jobArtifactsTable)
        .values({ jobId: job.id, version: 1, payload, hash })
        .returning();
      if (!art) throw new Error("Failed to insert artifact row");

      await tx
        .update(jobsTable)
        .set({ currentArtifactId: art.id, updatedAt: new Date() })
        .where(eq(jobsTable.id, job.id));

      logger.info(
        { jobId: job.id, artifactId: art.id },
        "Created synthetic daemon-test relic",
      );
      return job.id;
    });

    res.status(201).json({ jobId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    logger.error({ err }, "Failed to create daemon-test relic");
    res.status(500).json({ error: "internal", message });
  }
});

export default router;
