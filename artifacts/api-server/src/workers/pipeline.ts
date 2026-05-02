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
import { runVerifier, type PolicyConfig as VerifierPolicy } from "./verifier.js";
import { logger } from "../lib/logger.js";

const JOB_TIMEOUT_MS = parseInt(process.env["JOB_TIMEOUT_MS"] ?? "300000", 10);

function buildArtifactHash(payload: object): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(canonical).digest("hex");
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

    const descriptor = job.kernelParams as JobDescriptor;
    const editorResult = await runEditor(descriptor);
    const { artifact } = editorResult;

    const hash = buildArtifactHash(artifact);
    const version = await getNextArtifactVersion(jobId);

    const [insertedArtifact] = await db
      .insert(jobArtifactsTable)
      .values({
        jobId,
        version,
        payload: artifact,
        hash,
      })
      .returning();

    if (!insertedArtifact) throw new Error("Failed to insert artifact");

    await db
      .update(jobsTable)
      .set({ status: "verifying", currentArtifactId: insertedArtifact.id, updatedAt: new Date() })
      .where(eq(jobsTable.id, jobId));

    logger.info({ jobId, artifactId: insertedArtifact.id, elapsed: Date.now() - start }, "Editor complete, starting verification");

    const policy = (job.policyConfig ?? {}) as Partial<VerifierPolicy>;
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

    const finalStatus =
      verifierResult.verdict === "pass"
        ? "complete"
        : verifierResult.verdict === "warn"
          ? "complete_with_warnings"
          : "failed";

    await db
      .update(jobsTable)
      .set({ status: finalStatus, updatedAt: new Date() })
      .where(eq(jobsTable.id, jobId));

    logger.info(
      { jobId, verdict: verifierResult.verdict, finalStatus, elapsed: Date.now() - start },
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

  const maxRetries = 3;
  if ((job.retryCount ?? 0) >= maxRetries) {
    logger.warn({ jobId }, "Max retries reached");
    return;
  }

  await db
    .update(jobsTable)
    .set({ status: "queued", retryCount: (job.retryCount ?? 0) + 1, updatedAt: new Date() })
    .where(eq(jobsTable.id, jobId));

  setImmediate(() => void runPipeline(jobId));
}
