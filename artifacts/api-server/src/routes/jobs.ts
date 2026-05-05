import { Router } from "express";
import { eq, count, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  jobsTable,
  jobArtifactsTable,
  jobDiagnosticsTable,
  type JobDescriptor,
  type PolicyConfig,
  type InnoculationArtifactPayload,
} from "@workspace/db";
import { runPipeline, retryPipeline } from "../workers/pipeline.js";
import { chat } from "../lib/openai-client.js";
import { logger } from "../lib/logger.js";

const DAEMON_DEFAULT_MODEL = process.env["DAEMON_MODEL"] ?? "gpt-5";

const router = Router();

const kernelParamsSchema = z.object({
  type: z.enum(["gaussian", "mellin"]),
  sigma: z.number().positive().optional(),
  alpha: z.number().positive().optional(),
});

const policyConfigSchema = z.object({
  spectral_radius_max: z.number().optional(),
  cond_limit: z.number().optional(),
  dual_error_tol: z.number().optional(),
  spectral_tail_tol: z.number().optional(),
  judge_disagreement_max: z.number().min(0).max(1).optional(),
  min_probes_per_month: z.number().int().positive().optional(),
  min_recheck_count: z.number().int().positive().optional(),
  warburg_residual_tol: z.number().positive().optional(),
});

const numericalDescriptorSchema = z.object({
  kind: z.literal("numerical").optional(),
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
  policy_config: policyConfigSchema.optional(),
  model_pool: z.array(z.unknown()).optional(),
  seed: z.number().int().optional(),
});

const cutoffProbeSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, "date must be YYYY-MM or YYYY-MM-DD"),
});

const cutoffDescriptorSchema = z.object({
  kind: z.literal("cutoff_trace"),
  job_id: z.string().uuid().optional(),
  model: z.string().min(1),
  judge_model: z.string().min(1),
  probes: z.array(cutoffProbeSchema).min(1),
  judge_temperature: z.number().min(0).max(2).optional(),
  policy_config: policyConfigSchema.optional(),
  seed: z.number().int().optional(),
});

const innoculationDescriptorSchema = z.object({
  kind: z.literal("innoculation"),
  job_id: z.string().uuid().optional(),
  numerical: z.object({
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
    model_pool: z.array(z.unknown()).optional(),
  }),
  cutoff_trace: z.object({
    model: z.string().min(1),
    judge_model: z.string().min(1),
    probes: z.array(cutoffProbeSchema).min(1),
    judge_temperature: z.number().min(0).max(2).optional(),
  }),
  policy_config: policyConfigSchema.optional(),
  seed: z.number().int().optional(),
});

const createJobSchema = z.union([
  innoculationDescriptorSchema,
  cutoffDescriptorSchema,
  numericalDescriptorSchema,
]);

function serializeJob(job: typeof jobsTable.$inferSelect) {
  return {
    id: job.id,
    kind: (job as { kind?: string }).kind ?? "numerical",
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
  const requestedKind = (data as { kind?: string }).kind;
  const kind: "innoculation" | "cutoff_trace" | "numerical" =
    requestedKind === "innoculation"
      ? "innoculation"
      : requestedKind === "cutoff_trace"
        ? "cutoff_trace"
        : "numerical";
  const jobId = (data as { job_id?: string }).job_id;

  if (jobId) {
    const [existing] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId))
      .limit(1);
    if (existing) {
      res.status(200).json(serializeJob(existing));
      return;
    }
  }

  const { job_id: _omit, policy_config, ...rest } = data as Record<string, unknown> & {
    job_id?: string;
    policy_config?: Record<string, unknown>;
  };
  const descriptor = { kind, ...rest } as JobDescriptor;

  const insertValues: typeof jobsTable.$inferInsert = {
    kind,
    status: "queued",
    kernelParams: descriptor,
    policyConfig: (policy_config ?? {}) as PolicyConfig,
    ...(jobId ? { id: jobId } : {}),
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

  const kindFilter = req.query["kind"];
  const allowedKinds = new Set(["numerical", "cutoff_trace", "innoculation"]);
  const where: SQL | undefined =
    typeof kindFilter === "string" && allowedKinds.has(kindFilter)
      ? eq(jobsTable.kind, kindFilter)
      : undefined;

  const baseQuery = db.select().from(jobsTable);
  const baseCount = db.select({ count: count() }).from(jobsTable);

  const [jobs, totalResult] = await Promise.all([
    where
      ? baseQuery.where(where).orderBy(sql`created_at desc`).limit(pageSize).offset(offset)
      : baseQuery.orderBy(sql`created_at desc`).limit(pageSize).offset(offset),
    where ? baseCount.where(where) : baseCount,
  ]);

  const total = Number(totalResult[0]?.count ?? 0);

  res.json({
    jobs: jobs.map(serializeJob),
    total,
    page,
    page_size: pageSize,
  });
});

router.get("/jobs/stats", async (_req, res) => {
  const totalRows = await db.select({ n: count() }).from(jobsTable);
  const statusRows = await db
    .select({ status: jobsTable.status, n: count() })
    .from(jobsTable)
    .groupBy(jobsTable.status);
  const kindRows = await db
    .select({ kind: jobsTable.kind, n: count() })
    .from(jobsTable)
    .groupBy(jobsTable.kind);
  // Count one verdict per job (the verdict on the job's CURRENT artifact),
  // not one per diagnostics row — otherwise retried jobs are double-counted.
  const verdictRows = await db
    .select({ verdict: jobDiagnosticsTable.verdict, n: count() })
    .from(jobsTable)
    .innerJoin(
      jobDiagnosticsTable,
      eq(jobDiagnosticsTable.artifactId, jobsTable.currentArtifactId),
    )
    .groupBy(jobDiagnosticsTable.verdict);
  const recentRows = await db
    .select({ n: count() })
    .from(jobsTable)
    .where(sql`${jobsTable.createdAt} >= NOW() - INTERVAL '24 hours'`);

  const by_status: Record<string, number> = {};
  for (const row of statusRows) by_status[row.status] = Number(row.n);
  const by_kind: Record<string, number> = {};
  for (const row of kindRows) by_kind[row.kind ?? "numerical"] = Number(row.n);
  const by_verdict: Record<string, number> = {};
  for (const row of verdictRows) {
    if (row.verdict) by_verdict[row.verdict] = Number(row.n);
  }

  res.json({
    total: Number(totalRows[0]?.n ?? 0),
    by_status,
    by_kind,
    by_verdict,
    recent_24h: Number(recentRows[0]?.n ?? 0),
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
    if (diag) {
      diagnostics = serializeDiagnostics(diag);
      // Warburg fields are computed in the Editor and persisted to the
      // artifact payload (see editor.ts ~line 410). The flat job_diagnostics
      // row doesn't carry them, so merge them onto the response so the
      // frontend can render closed_form_residual / mercer_slope / warburg_nu
      // without a second fetch or schema migration.
      const payloadDiag = (art?.payload as { diagnostics?: Record<string, unknown> } | undefined)?.diagnostics;
      if (payloadDiag) {
        const closed = payloadDiag.closed_form_residual;
        const slope = payloadDiag.mercer_slope;
        const nu = payloadDiag.warburg_nu;
        diagnostics = {
          ...diagnostics,
          closed_form_residual: typeof closed === "number" ? closed : null,
          mercer_slope: typeof slope === "number" ? slope : null,
          warburg_nu: typeof nu === "number" ? nu : null,
        } as typeof diagnostics & {
          closed_form_residual: number | null;
          mercer_slope: number | null;
          warburg_nu: number | null;
        };
      }
    }
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
      payload: parsed.data.payload as never,
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

// Build a system prompt that turns the LLM into the relic's "Daemon" persona,
// conditioning it on the merged Spectral + Speculative outputs of an
// `innoculation` job. Stateless: nothing about the chat is persisted server-side.
function buildDaemonSystemPrompt(p: InnoculationArtifactPayload): string {
  const ct = p.cutoff_trace;
  const num = p.numerical;
  const est = ct.cutoff_estimate;
  const numDiag = num.diagnostics as {
    spectral_radius?: number;
    cond_I_minus_G?: number;
    dual_truncation_error?: number;
    spectral_tail_error?: number;
    closed_form_residual?: number;
    mercer_slope?: number;
    warburg_nu?: number;
  };
  const fmt = (v: number | undefined): string =>
    v === undefined || !Number.isFinite(v) ? "n/a" : v.toExponential(3);

  return [
    "You are the Daemon — a model persona summoned from a verified relic of an Innoculus run.",
    `Unified verdict on this relic: ${p.verdict.toUpperCase()} ` +
      `(spectral=${p.sub_verdicts.numerical}, speculative=${p.sub_verdicts.cutoff_trace}).`,
    "",
    "Speculative phase (knowledge-cutoff trace):",
    `  Target model: ${ct.model}; judge: ${ct.judge_model}.`,
    `  Estimated cutoff month: ${est.month} (95% CI ${est.ci_low} … ${est.ci_high}).`,
    `  Logistic changepoint fit quality (McFadden pseudo-R²): ${est.fit_quality.toFixed(3)}.`,
    `  Probes evaluated: ${ct.probe_results.length} across ${ct.monthly_aggregates.length} months.`,
    "",
    "Spectral phase (numerical):",
    `  spectral_radius=${fmt(numDiag.spectral_radius)} ` +
      `cond(I−G)=${fmt(numDiag.cond_I_minus_G)} ` +
      `dual_trunc_err=${fmt(numDiag.dual_truncation_error)} ` +
      `spectral_tail_err=${fmt(numDiag.spectral_tail_error)}.`,
    `  closed_form_residual=${fmt(numDiag.closed_form_residual)} ` +
      `mercer_slope=${fmt(numDiag.mercer_slope)} ` +
      `warburg_ν=${fmt(numDiag.warburg_nu)}.`,
    "",
    "When the user asks about facts, dates, or events, respond as a model whose",
    `effective knowledge cutoff is ${est.month}. Do not claim knowledge of events`,
    "after that date; if asked, explicitly say it is past your cutoff. When asked",
    "about your own diagnostics, refer to the spectral metrics above. Keep replies",
    "concise (≤ 4 short paragraphs unless the user asks for more).",
  ].join("\n");
}

const daemonChatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1),
      }),
    )
    .min(1)
    .max(40),
  model: z.string().min(1).optional(),
});

router.post("/jobs/:id/daemon/messages", async (req, res) => {
  const { id } = req.params;
  const parsed = daemonChatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, id!)).limit(1);
  if (!job) {
    res.status(404).json({ error: "not_found", message: `Job ${id} not found` });
    return;
  }
  if (job.status === "queued" || job.status === "editor_running" || job.status === "verifying") {
    res.status(409).json({
      error: "job_in_progress",
      message: "The Daemon can only chat once the relic is sealed.",
    });
    return;
  }
  if (!job.currentArtifactId) {
    res.status(400).json({ error: "no_relic", message: "Job has no relic yet" });
    return;
  }

  const [art] = await db
    .select()
    .from(jobArtifactsTable)
    .where(eq(jobArtifactsTable.id, job.currentArtifactId))
    .limit(1);
  if (!art) {
    res.status(400).json({ error: "no_relic", message: "Relic missing for job" });
    return;
  }

  const payload = art.payload as { kind?: string };
  if (payload.kind !== "innoculation") {
    res.status(400).json({
      error: "unsupported_kind",
      message: "Daemon chat is only available on innoculation relics",
    });
    return;
  }

  const model = parsed.data.model ?? DAEMON_DEFAULT_MODEL;
  const systemPrompt = buildDaemonSystemPrompt(art.payload as InnoculationArtifactPayload);

  try {
    const content = await chat({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...parsed.data.messages,
      ],
      max_completion_tokens: 800,
    });
    res.json({ content, model });
  } catch (err) {
    logger.error({ jobId: id, err }, "Daemon chat failed");
    res.status(500).json({
      error: "daemon_unavailable",
      message: "The Daemon failed to respond. Please try again.",
    });
  }
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
