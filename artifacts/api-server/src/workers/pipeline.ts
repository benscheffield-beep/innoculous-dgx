import { eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import {
  jobsTable,
  jobArtifactsTable,
  jobDiagnosticsTable,
  type JobDescriptor,
  type PolicyConfig,
} from "@workspace/db";
import { runEditor } from "./editor.js";
import { runVerifier, type PolicyConfig as VerifierPolicy, type Verdict } from "./verifier.js";
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

function buildArtifactHash(payload: object): string {
  function deepCanonical(v: unknown): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean" || typeof v === "number") return JSON.stringify(v);
    if (typeof v === "string") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(deepCanonical).join(",") + "]";
    if (typeof v === "object") {
      const sorted = Object.keys(v as Record<string, unknown>).sort();
      const pairs = sorted.map(k => `${JSON.stringify(k)}:${deepCanonical((v as Record<string, unknown>)[k])}`);
      return "{" + pairs.join(",") + "}";
    }
    return JSON.stringify(v);
  }
  return createHash("sha256").update(deepCanonical(payload)).digest("hex");
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
  let d: JobDescriptor = JSON.parse(JSON.stringify(descriptor)) as JobDescriptor;
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

  const editorResult = await runEditor(descriptor);
  const { artifact } = editorResult;

  const hash = buildArtifactHash(artifact);
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

  const verifierResult = await runVerifier(artifact, hash, policy);

  const [insertedDiag] = await db
    .insert(jobDiagnosticsTable)
    .values({
      jobId,
      artifactId: insertedArtifact.id,
      spectralRadius: artifact.diagnostics.spectral_radius,
      condIMinusG: artifact.diagnostics.cond_I_minus_G,
      dualTruncationError: artifact.diagnostics.dual_truncation_error,
      spectralTailError: artifact.diagnostics.spectral_tail_error,
      verdict: verifierResult.verdict,
      issues: verifierResult.issues,
    })
    .returning();

  if (!insertedDiag) throw new Error("Failed to insert diagnostics");

  await db
    .update(jobArtifactsTable)
    .set({ signedProof: verifierResult.signed_proof })
    .where(eq(jobArtifactsTable.id, insertedArtifact.id));

  return {
    verdict: verifierResult.verdict,
    issues: verifierResult.issues,
    artifactId: insertedArtifact.id,
    signedProof: verifierResult.signed_proof,
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
    logger.info({ jobId }, "Editor pipeline starting");

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
