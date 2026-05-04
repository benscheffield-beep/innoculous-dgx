import { pgTable, uuid, integer, jsonb, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobsTable } from "./jobs";

export interface NumericalArtifactPayload {
  kind?: "numerical";
  dual_indices: number[][];
  F: Record<string, number>;
  S: Record<string, number>;
  Phi_coeffs: number[];
  R_coeffs: number[];
  U_meta: { basis: number[][]; eigenvalues: number[] };
  diagnostics: {
    spectral_radius: number;
    cond_I_minus_G: number;
    dual_truncation_error: number;
    spectral_tail_error: number;
    // Warburg closed-form oracle (optional; null when kernel is non-Warburg)
    warburg_nu?: number | null;
    closed_form_residual?: number | null;
    mercer_slope?: number | null;
    kernel_cutoff_value?: number | null;
  };
}

export interface CutoffProbeResult {
  question: string;
  answer: string;
  date: string;
  model_answer: string;
  judge_score: number;
  judge_reasoning: string;
}

export interface MonthlyAggregate {
  month: string;
  n: number;
  knew_rate: number;
}

export interface CutoffEstimate {
  month: string;
  ci_low: string;
  ci_high: string;
  fit_quality: number;
}

export interface CutoffArtifactPayload {
  kind: "cutoff_trace";
  model: string;
  judge_model: string;
  probe_results: CutoffProbeResult[];
  monthly_aggregates: MonthlyAggregate[];
  cutoff_estimate: CutoffEstimate;
}

export type ArtifactPayload = NumericalArtifactPayload | CutoffArtifactPayload;

export function isCutoffArtifact(p: ArtifactPayload): p is CutoffArtifactPayload {
  return (p as { kind?: string }).kind === "cutoff_trace";
}

export const jobArtifactsTable = pgTable("job_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobsTable.id),
  version: integer("version").notNull().default(1),
  payload: jsonb("payload").$type<ArtifactPayload>().notNull(),
  hash: text("hash").notNull(),
  signedProof: text("signed_proof"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertJobArtifactSchema = createInsertSchema(jobArtifactsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertJobArtifact = z.infer<typeof insertJobArtifactSchema>;
export type JobArtifact = typeof jobArtifactsTable.$inferSelect;
