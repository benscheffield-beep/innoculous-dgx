import { pgTable, uuid, text, jsonb, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type JobStatus =
  | "queued"
  | "editor_running"
  | "verifying"
  | "complete"
  | "complete_with_warnings"
  | "failed";

export type JobKind = "numerical" | "cutoff_trace";

export interface KernelParams {
  type: "gaussian" | "mellin";
  sigma?: number;
  alpha?: number;
}

export interface PolicyConfig {
  spectral_radius_max?: number;
  cond_limit?: number;
  dual_error_tol?: number;
  spectral_tail_tol?: number;
  // cutoff_trace policy thresholds
  judge_disagreement_max?: number;
  min_probes_per_month?: number;
  min_recheck_count?: number;
  // Warburg closed-form oracle threshold (numerical pipeline)
  warburg_residual_tol?: number;
}

export interface NumericalDescriptor {
  kind?: "numerical";
  kernel: KernelParams;
  Q: number[][];
  truncation: { M: number; r: number };
  latency: { lambda: number; delta: number; Tnow: number };
  precision: { b: number; tol: number; safety_margin?: number };
  policy_config?: PolicyConfig;
  model_pool?: unknown[];
  seed?: number;
}

export interface CutoffProbe {
  question: string;
  answer: string;
  date: string;
}

export interface CutoffTraceDescriptor {
  kind: "cutoff_trace";
  model: string;
  judge_model: string;
  probes: CutoffProbe[];
  judge_temperature?: number;
  seed?: number;
}

export type JobDescriptor = NumericalDescriptor | CutoffTraceDescriptor;

export const jobsTable = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull().default("numerical"),
  status: text("status").notNull().default("queued"),
  kernelParams: jsonb("kernel_params").$type<JobDescriptor>().notNull(),
  policyConfig: jsonb("policy_config").$type<PolicyConfig>().notNull().default({}),
  currentArtifactId: uuid("current_artifact_id"),
  retryCount: integer("retry_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertJobSchema = createInsertSchema(jobsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
