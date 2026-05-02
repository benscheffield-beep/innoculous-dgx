import { Router } from "express";
import { eq, count, sql } from "drizzle-orm";
import { z } from "zod";
import { db, jobsTable, jobArtifactsTable, jobDiagnosticsTable } from "@workspace/db";
import { runPipeline, retryPipeline } from "../workers/pipeline.js";
import { logger } from "../lib/logger.js";

const router = Router();

const kernelParamsSchema = z.object({
  type: z.enum(["gaussian", "mellin"]),
  sigma: z.number().positive().optional(),
  alpha: z.number().positive().optional(),
});

const createJobSchema = z.object({
  job_id: z.string().uuid().optional(),
  kernel: kernelParamsSchema,
  Q: z.array(z.array(z.number())).min(1),
  truncation: z.object({ M: z.number().int().positive(), r: z.number().int().positive() }),
  latency: z.object({
    lambda: z.number().positive(),
    delta: z.number().nonnegative(),
    Tnow: z.number().nonnegative(),
  }),
  precision: z.object({
    b: z.number().int().positive(),
    tol: z.number().positive(),
    safety_margin: z.number().positive().optional(),
  }),
  policy_config: z
    .object({
      spectral_radius_max: z.number().optional(),
      cond_limit: z.number().optional(),
      dual_error_tol: z.number().optional(),
      spectral_tail_tol: z.number().optional(),
    })
    .optional(),
  model_pool: z.array(z.unknown()).optional(),
  seed: z.number().int().optional(),
});

function serializeJob(job: typeof jobsTable.$inferSelect) {
  return {
    id: job.id,
    status: job.status,
    kernel_params: job.kernelParams,
    policy_config: job.policyConfig,
    current_artifact_id: job.currentArtifactId ?? null,
    retry_count: job.retryCount,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  };
}

function serializeArtifact(a: typeof jobArtifactsTable.$inferSelect) {
  return {
    id: a.id,
    job_id: a.jobId,
    version: a.version,
    payload: a.payload,
    hash: a.hash,
    signed_proof: a.signedProof ?? null,
    created_at: a.createdAt,
  };
}

function serializeDiagnostics(d: typeof jobDiagnosticsTable.$inferSelect) {
  return {
    id: d.id,
    job_id: d.jobId,
    artifact_id: d.artifactId,
    spectral_radius: d.spectralRadius,
    cond_i_minus_g: d.condIMinusG,
    dual_truncation_error: d.dualTruncationError,
    spectral_tail_error: d.spectralTailError,
    verdict: d.verdict,
    issues: d.issues,
    created_at: d.createdAt,
  };
}

router.post("/jobs", async (req, res) => {
  const parsed = createJobSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }

  const data = parsed.data;

  if (data.job_id) {
    const [existing] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, data.job_id))
      .limit(1);
    if (existing) {
      res.status(200).json(serializeJob(existing));
      return;
    }
  }

  const descriptor = {
    kernel: data.kernel,
    Q: data.Q,
    truncation: data.truncation,
    latency: data.latency,
    precision: data.precision,
    policy_config: data.policy_config,
    model_pool: data.model_pool,
    seed: data.seed,
  };

  const insertValues: Parameters<typeof db.insert>[0] extends never
    ? never
    : {
        status: string;
        kernelParams: typeof descriptor;
        policyConfig: NonNullable<typeof data.policy_config>;
        id?: string;
      } = {
    status: "queued",
    kernelParams: descriptor,
    policyConfig: data.policy_config ?? {},
    ...(data.job_id ? { id: data.job_id } : {}),
  };

  const [inserted] = await db.insert(jobsTable).values(insertValues).returning();
  if (!inserted) {
    res.status(500).json({ error: "internal_error", message: "Failed to create job" });
    return;
  }

  setImmediate(() => {
    void runPipeline(inserted.id).catch((err: unknown) => {
      logger.error({ jobId: inserted.id, err }, "Background pipeline error");
    });
  });

  res.status(201).json(serializeJob(inserted));
});

router.get("/jobs", async (req, res) => {
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query["page_size"] ?? "20"), 10)));
  const offset = (page - 1) * pageSize;

  const [jobs, totalResult] = await Promise.all([
    db.select().from(jobsTable).orderBy(sql`created_at desc`).limit(pageSize).offset(offset),
    db.select({ count: count() }).from(jobsTable),
  ]);

  const total = Number(totalResult[0]?.count ?? 0);

  res.json({
    jobs: jobs.map(serializeJob),
    total,
    page,
    page_size: pageSize,
  });
});

router.get("/jobs/:id", async (req, res) => {
  const { id } = req.params;

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, id!)).limit(1);
  if (!job) {
    res.status(404).json({ error: "not_found", message: `Job ${id} not found` });
    return;
  }

  let artifact = null;
  let diagnostics = null;

  if (job.currentArtifactId) {
    const [art] = await db
      .select()
      .from(jobArtifactsTable)
      .where(eq(jobArtifactsTable.id, job.currentArtifactId))
      .limit(1);
    if (art) artifact = serializeArtifact(art);

    const [diag] = await db
      .select()
      .from(jobDiagnosticsTable)
      .where(eq(jobDiagnosticsTable.artifactId, job.currentArtifactId))
      .limit(1);
    if (diag) diagnostics = serializeDiagnostics(diag);
  }

  res.json({ ...serializeJob(job), artifact, diagnostics });
});

router.patch("/jobs/:id/status", async (req, res) => {
  const { id } = req.params;
  const schema = z.object({ status: z.string(), step: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }

  const [updated] = await db
    .update(jobsTable)
    .set({ status: parsed.data.status, updatedAt: new Date() })
    .where(eq(jobsTable.id, id!))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "not_found", message: `Job ${id} not found` });
    return;
  }

  res.json(serializeJob(updated));
});

router.put("/jobs/:id/artifact", async (req, res) => {
  const { id } = req.params;
  const schema = z.object({ payload: z.record(z.unknown()), hash: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, id!)).limit(1);
  if (!job) {
    res.status(404).json({ error: "not_found", message: `Job ${id} not found` });
    return;
  }

  const existing = await db
    .select({ version: jobArtifactsTable.version })
    .from(jobArtifactsTable)
    .where(eq(jobArtifactsTable.jobId, id!))
    .orderBy(sql`version desc`)
    .limit(1);
  const version = (existing[0]?.version ?? 0) + 1;

  const [inserted] = await db
    .insert(jobArtifactsTable)
    .values({
      jobId: id!,
      version,
      payload: parsed.data.payload as Parameters<typeof db.insert>[0] extends never ? never : typeof jobArtifactsTable.$inferInsert["payload"],
      hash: parsed.data.hash,
    })
    .returning();

  if (!inserted) {
    res.status(500).json({ error: "internal_error", message: "Failed to store artifact" });
    return;
  }

  await db
    .update(jobsTable)
    .set({ currentArtifactId: inserted.id, updatedAt: new Date() })
    .where(eq(jobsTable.id, id!));

  res.json(serializeArtifact(inserted));
});

router.post("/jobs/:id/work", async (req, res) => {
  const { id } = req.params;
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, id!)).limit(1);
  if (!job) {
    res.status(404).json({ error: "not_found", message: `Job ${id} not found` });
    return;
  }

  res.status(202).json({ dispatched: true, job_id: id });
});

router.post("/jobs/:id/verify", async (req, res) => {
  const { id } = req.params;
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, id!)).limit(1);
  if (!job) {
    res.status(404).json({ error: "not_found", message: `Job ${id} not found` });
    return;
  }

  res.status(202).json({ dispatched: true, job_id: id });
});

router.post("/jobs/:id/verdict", async (req, res) => {
  const { id } = req.params;
  const schema = z.object({
    verdict: z.enum(["pass", "warn", "fail"]),
    issues: z.array(z.unknown()).default([]),
    recomputed_metrics: z.record(z.unknown()),
    signed_proof: z.string(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }

  const finalStatus =
    parsed.data.verdict === "pass"
      ? "complete"
      : parsed.data.verdict === "warn"
        ? "complete_with_warnings"
        : "failed";

  const [updated] = await db
    .update(jobsTable)
    .set({ status: finalStatus, updatedAt: new Date() })
    .where(eq(jobsTable.id, id!))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "not_found", message: `Job ${id} not found` });
    return;
  }

  res.json(serializeJob(updated));
});

router.post("/jobs/:id/retry", async (req, res) => {
  const { id } = req.params;
  await retryPipeline(id!);
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, id!)).limit(1);
  if (!job) {
    res.status(404).json({ error: "not_found", message: `Job ${id} not found` });
    return;
  }
  res.json(serializeJob(job));
});

export default router;
