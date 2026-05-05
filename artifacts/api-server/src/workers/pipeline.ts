import { eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  jobsTable,
  jobArtifactsTable,
  jobDiagnosticsTable,
  isCutoffArtifact,
  isInnoculationArtifact,
  type JobDescriptor,
  type NumericalDescriptor,
  type CutoffTraceDescriptor,
  type InnoculationDescriptor,
  type ArtifactPayload,
  type CutoffArtifactPayload,
  type NumericalArtifactPayload,
  type InnoculationArtifactPayload,
} from "@workspace/db";
import { runEditor } from "./editor.js";
import { runVerifier, signArtifact, type PolicyConfig as VerifierPolicy, type Verdict, computeArtifactHash } from "./verifier.js";
import { runCutoffEditor } from "./cutoff-editor.js";
import { runCutoffVerifier } from "./cutoff-verifier.js";
import type { DiagnosticIssue } from "@workspace/db";
import { logger } from "../lib/logger.js";

const JOB_TIMEOUT_MS = parseInt(process.env["JOB_TIMEOUT_MS"] ?? "300000", 10);
const MAX_AUTO_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
const MAX_BACKOFF_MS = 10000;

function backoffDelay(retryCount: number): number {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, retryCount), MAX_BACKOFF_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function setStatus(jobId: string, status: string): Promise<void> {
  await db
    .update(jobsTable)
    .set({ status, updatedAt: new Date() })
    .where(eq(jobsTable.id, jobId));
}

async function getNextArtifactVersion(jobId: string): Promise<number> {
  const existing = await db
    .select({ version: jobArtifactsTable.version })
    .from(jobArtifactsTable)
    .where(eq(jobArtifactsTable.jobId, jobId))
    .orderBy(sql`version desc`)
    .limit(1);
  return (existing[0]?.version ?? 0) + 1;
}

function applyRemediation(
  descriptor: JobDescriptor,
  issues: DiagnosticIssue[]
): { descriptor: JobDescriptor; changed: boolean } {
  const actions = new Set(issues.map(i => i.remediation));

  if ((descriptor as CutoffTraceDescriptor).kind === "cutoff_trace") {
    const d: CutoffTraceDescriptor = JSON.parse(JSON.stringify(descriptor)) as CutoffTraceDescriptor;
    let changed = false;
    if (actions.has("re_run_judge_with_higher_temperature_floor")) {
      const cur = d.judge_temperature ?? 0;
      d.judge_temperature = Math.min(1, Math.max(0.2, cur + 0.2));
      changed = true;
    }
    // Note: `request_more_probes_in_window` is intentionally NOT auto-applied.
    // The Editor cannot synthesize new probes — that requires a fresh user
    // submission. Lowering the coverage threshold would mask the data-sufficiency
    // signal CT04 is meant to surface. The warn is left visible on the diagnostics
    // row so the caller can decide whether to resubmit with more probes.
    return { descriptor: d, changed };
  }

  const d: NumericalDescriptor = JSON.parse(JSON.stringify(descriptor)) as NumericalDescriptor;
  let changed = false;

  if (actions.has("apply_damping_to_G_off")) {
    d.precision = {
      ...d.precision,
      safety_margin: Math.min(0.1, (d.precision.safety_margin ?? 1e-3) * 10),
    };
    changed = true;
  }

  if (actions.has("increase_regulator_epsilon")) {
    d.precision = {
      ...d.precision,
      safety_margin: Math.min(0.1, ((d.precision.safety_margin ?? 1e-3) + 0.005) * 2),
    };
    changed = true;
  }

  if (actions.has("reduce_truncation_radius_M") && d.truncation.M > 1) {
    d.truncation = { ...d.truncation, M: Math.max(1, d.truncation.M - 1) };
    changed = true;
  }

  if (actions.has("recommend_increase_r")) {
    d.truncation = { ...d.truncation, r: d.truncation.r + 1 };
    changed = true;
  }

  if (actions.has("recommend_increase_b")) {
    d.precision = { ...d.precision, b: Math.min(d.precision.b * 2, 512) };
    changed = true;
  }

  if (actions.has("reject_artifact_and_request_recompute") && !changed) {
    d.precision = { ...d.precision, safety_margin: 0.01 };
    changed = true;
  }

  return { descriptor: d, changed };
}

function worstVerdict(a: Verdict, b: Verdict): Verdict {
  if (a === "fail" || b === "fail") return "fail";
  if (a === "warn" || b === "warn") return "warn";
  return "pass";
}

function collectInnoculationIssues(p: InnoculationArtifactPayload): DiagnosticIssue[] {
  // Namespace each sub-issue so the UI can attribute it to the right phase.
  const tag = (phase: "spectral" | "speculative") => (i: DiagnosticIssue): DiagnosticIssue => ({
    ...i,
    check_id: `${phase}:${i.check_id}`,
  });
  const numIssues = ((p.numerical.diagnostics as { issues?: DiagnosticIssue[] })?.issues ?? []).map(
    tag("spectral"),
  );
  const ctIssues = (
    ((p.cutoff_trace as unknown) as { issues?: DiagnosticIssue[] }).issues ?? []
  ).map(tag("speculative"));
  return [...numIssues, ...ctIssues];
}

/**
 * Runs the Spectral and Speculative editors+verifiers in parallel, then folds
 * their outputs into a single `innoculation` relic. The unified verdict is
 * the worst of the two sub-verdicts. We do NOT remediate-and-retry inside
 * this cycle — each phase has its own remediation universe and combining them
 * cleanly is out of scope for the merged pipeline.
 */
async function runInnoculationCycle(
  descriptor: InnoculationDescriptor,
  policy: Partial<VerifierPolicy>,
): Promise<{ artifact: InnoculationArtifactPayload; mergedMetrics: Record<string, unknown> }> {
  const numDescriptor: NumericalDescriptor = {
    kind: "numerical",
    ...descriptor.numerical,
  };
  const ctDescriptor: CutoffTraceDescriptor = {
    kind: "cutoff_trace",
    ...descriptor.cutoff_trace,
  };

  const [numRes, ctRes] = await Promise.all([
    runEditor(numDescriptor),
    runCutoffEditor(ctDescriptor),
  ]);

  const numHash = computeArtifactHash(numRes.artifact);
  const ctHash = computeArtifactHash(ctRes.artifact);

  const pc = policy as {
    judge_disagreement_max?: number;
    min_probes_per_month?: number;
    min_recheck_count?: number;
  };

  const [numVerify, ctVerify] = await Promise.all([
    runVerifier(numRes.artifact, numHash, policy),
    runCutoffVerifier(ctRes.artifact, ctHash, {
      policy: {
        ...(pc.judge_disagreement_max !== undefined ? { judge_disagreement_max: pc.judge_disagreement_max } : {}),
        ...(pc.min_probes_per_month !== undefined ? { min_probes_per_month: pc.min_probes_per_month } : {}),
        ...(pc.min_recheck_count !== undefined ? { min_recheck_count: pc.min_recheck_count } : {}),
      },
    }),
  ]);

  // Stamp issues onto each sub-payload so the merged payload's diagnostics
  // carry per-phase attribution without a separate side table.
  const numWithIssues: NumericalArtifactPayload = {
    ...numRes.artifact,
    diagnostics: {
      ...numRes.artifact.diagnostics,
      ...({ issues: numVerify.issues } as Record<string, unknown>),
    } as NumericalArtifactPayload["diagnostics"],
  };
  const ctWithIssues = {
    ...ctRes.artifact,
    issues: ctVerify.issues,
  } as CutoffArtifactPayload;

  return {
    artifact: {
      kind: "innoculation",
      verdict: worstVerdict(numVerify.verdict, ctVerify.verdict),
      sub_verdicts: {
        numerical: numVerify.verdict,
        cutoff_trace: ctVerify.verdict,
      },
      numerical: numWithIssues,
      cutoff_trace: ctWithIssues,
    },
    mergedMetrics: {
      numerical: numVerify.recomputed_metrics,
      cutoff_trace: ctVerify.recomputed_metrics,
    },
  };
}

async function runEditorVerifierCycle(
  jobId: string,
  descriptor: JobDescriptor,
  policy: Partial<VerifierPolicy>,
  attemptNumber: number
): Promise<{
  verdict: Verdict;
  issues: DiagnosticIssue[];
  artifactId: string;
  signedProof: string;
}> {
  if (attemptNumber > 0) {
    await sleep(backoffDelay(attemptNumber - 1));
  }

  let artifact: ArtifactPayload;
  let innoculationMergedMetrics: Record<string, unknown> | null = null;
  const dKind = (descriptor as { kind?: string }).kind;
  if (dKind === "innoculation") {
    const r = await runInnoculationCycle(descriptor as InnoculationDescriptor, policy);
    artifact = r.artifact;
    innoculationMergedMetrics = r.mergedMetrics;
  } else if (dKind === "cutoff_trace") {
    const r = await runCutoffEditor(descriptor as CutoffTraceDescriptor);
    artifact = r.artifact;
  } else {
    const r = await runEditor(descriptor as NumericalDescriptor);
    artifact = r.artifact;
  }

  const hash = computeArtifactHash(artifact);
  const version = await getNextArtifactVersion(jobId);

  const [insertedArtifact] = await db
    .insert(jobArtifactsTable)
    .values({ jobId, version, payload: artifact, hash })
    .returning();

  if (!insertedArtifact) throw new Error("Failed to insert artifact");

  await db
    .update(jobsTable)
    .set({ status: "verifying", currentArtifactId: insertedArtifact.id, updatedAt: new Date() })
    .where(eq(jobsTable.id, jobId));

  let verdict: Verdict;
  let issues: DiagnosticIssue[];
  let signed_proof: string;
  let diagInsert: typeof jobDiagnosticsTable.$inferInsert;

  if (isInnoculationArtifact(artifact)) {
    const innoc = artifact;
    verdict = innoc.verdict;
    issues = collectInnoculationIssues(innoc);
    signed_proof = signArtifact(hash, innoculationMergedMetrics ?? {}, verdict);
    // Store the merged numerical sub-payload's flat metrics in the diagnostics
    // row so existing diagnostics-based dashboards keep working. The full
    // sub-payload data lives in the artifact payload itself.
    diagInsert = {
      jobId,
      artifactId: insertedArtifact.id,
      spectralRadius: innoc.numerical.diagnostics.spectral_radius,
      condIMinusG: innoc.numerical.diagnostics.cond_I_minus_G,
      dualTruncationError: innoc.numerical.diagnostics.dual_truncation_error,
      spectralTailError: innoc.numerical.diagnostics.spectral_tail_error,
      verdict,
      issues,
    };
  } else if (isCutoffArtifact(artifact)) {
    const cutoffPayload: CutoffArtifactPayload = artifact;
    const pc = policy as {
      judge_disagreement_max?: number;
      min_probes_per_month?: number;
      min_recheck_count?: number;
    };
    const r = await runCutoffVerifier(cutoffPayload, hash, {
      policy: {
        ...(pc.judge_disagreement_max !== undefined
          ? { judge_disagreement_max: pc.judge_disagreement_max }
          : {}),
        ...(pc.min_probes_per_month !== undefined
          ? { min_probes_per_month: pc.min_probes_per_month }
          : {}),
        ...(pc.min_recheck_count !== undefined
          ? { min_recheck_count: pc.min_recheck_count }
          : {}),
      },
    });
    verdict = r.verdict;
    issues = r.issues;
    signed_proof = r.signed_proof;
    diagInsert = {
      jobId,
      artifactId: insertedArtifact.id,
      spectralRadius: 0,
      condIMinusG: 0,
      dualTruncationError: r.recomputed_metrics.judge_disagreement_rate,
      spectralTailError: r.recomputed_metrics.monotonicity_violation,
      verdict,
      issues,
    };
  } else {
    const numPayload: NumericalArtifactPayload = artifact;
    const r = await runVerifier(numPayload, hash, policy);
    verdict = r.verdict;
    issues = r.issues;
    signed_proof = r.signed_proof;
    diagInsert = {
      jobId,
      artifactId: insertedArtifact.id,
      spectralRadius: numPayload.diagnostics.spectral_radius,
      condIMinusG: numPayload.diagnostics.cond_I_minus_G,
      dualTruncationError: numPayload.diagnostics.dual_truncation_error,
      spectralTailError: numPayload.diagnostics.spectral_tail_error,
      verdict,
      issues,
    };
  }

  const [insertedDiag] = await db.insert(jobDiagnosticsTable).values(diagInsert).returning();
  if (!insertedDiag) throw new Error("Failed to insert diagnostics");

  await db
    .update(jobArtifactsTable)
    .set({ signedProof: signed_proof })
    .where(eq(jobArtifactsTable.id, insertedArtifact.id));

  return {
    verdict,
    issues,
    artifactId: insertedArtifact.id,
    signedProof: signed_proof,
  };
}

export async function runPipeline(jobId: string): Promise<void> {
  const start = Date.now();
  const timeoutHandle = setTimeout(async () => {
    logger.error({ jobId }, "Pipeline timeout");
    await setStatus(jobId, "failed").catch(() => undefined);
  }, JOB_TIMEOUT_MS);

  try {
    const [job] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId))
      .limit(1);

    if (!job) {
      logger.error({ jobId }, "Job not found for pipeline execution");
      clearTimeout(timeoutHandle);
      return;
    }

    if (job.status !== "queued") {
      logger.warn({ jobId, status: job.status }, "Job not in queued state, skipping pipeline");
      clearTimeout(timeoutHandle);
      return;
    }

    await setStatus(jobId, "editor_running");
    logger.info({ jobId, kind: (job as { kind?: string }).kind }, "Editor pipeline starting");

    let descriptor = job.kernelParams as JobDescriptor;
    const policy = (job.policyConfig ?? {}) as Partial<VerifierPolicy>;
    let finalVerdict: Verdict = "fail";
    let lastIssues: DiagnosticIssue[] = [];

    for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt++) {
      if (attempt > 0) {
        await setStatus(jobId, "editor_running");
      }

      const result = await runEditorVerifierCycle(jobId, descriptor, policy, attempt);
      finalVerdict = result.verdict;
      lastIssues = result.issues;

      logger.info(
        { jobId, attempt, verdict: result.verdict, issues: result.issues.length, elapsed: Date.now() - start },
        "Editor/Verifier cycle complete"
      );

      if (result.verdict === "pass" || result.verdict === "warn") {
        break;
      }

      // Innoculation jobs do not auto-remediate: each phase has its own
      // remediation universe and the user explicitly opted into the merged
      // pipeline. Surface the failure verdict directly.
      if ((descriptor as { kind?: string }).kind === "innoculation") {
        break;
      }

      if (attempt < MAX_AUTO_RETRIES) {
        const { descriptor: remediatedDescriptor, changed } = applyRemediation(descriptor, result.issues);
        if (changed) {
          logger.warn(
            { jobId, attempt, remediations: result.issues.map(i => i.remediation) },
            "Applying remediation actions before retry"
          );
          descriptor = remediatedDescriptor;
          await db
            .update(jobsTable)
            .set({
              kernelParams: descriptor,
              retryCount: attempt + 1,
              updatedAt: new Date(),
            })
            .where(eq(jobsTable.id, jobId));
        } else {
          logger.warn({ jobId, attempt }, "No actionable remediation available; giving up");
          break;
        }
      }
    }

    const finalStatus =
      finalVerdict === "pass"
        ? "complete"
        : finalVerdict === "warn"
          ? "complete_with_warnings"
          : "failed";

    await db
      .update(jobsTable)
      .set({ status: finalStatus, updatedAt: new Date() })
      .where(eq(jobsTable.id, jobId));

    logger.info(
      {
        jobId,
        finalVerdict,
        finalStatus,
        failIssues: lastIssues.filter(i => i.severity === "fail").length,
        warnIssues: lastIssues.filter(i => i.severity === "warn").length,
        elapsed: Date.now() - start,
      },
      "Pipeline complete"
    );
  } catch (err) {
    logger.error({ jobId, err }, "Pipeline error");
    await setStatus(jobId, "failed").catch(() => undefined);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function retryPipeline(jobId: string): Promise<void> {
  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId))
    .limit(1);

  if (!job || job.status !== "failed") {
    logger.warn({ jobId }, "Cannot retry: job not in failed state");
    return;
  }

  const maxManualRetries = 3;
  if ((job.retryCount ?? 0) >= maxManualRetries) {
    logger.warn({ jobId }, "Max manual retries reached");
    return;
  }

  await db
    .update(jobsTable)
    .set({ status: "queued", retryCount: (job.retryCount ?? 0) + 1, updatedAt: new Date() })
    .where(eq(jobsTable.id, jobId));

  setImmediate(() => void runPipeline(jobId).catch((err: unknown) => {
    logger.error({ jobId, err }, "Retry pipeline error");
  }));
}
