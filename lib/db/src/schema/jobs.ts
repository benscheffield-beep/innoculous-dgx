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

export interface KernelParams {
  type: "gaussian" | "mellin";
  sigma?: number;
  alpha?: number;
}

export interface JobDescriptor {
  kernel: KernelParams;
  Q: number[][];
  truncation: { M: number; r: number };
  latency: { lambda: number; delta: number; Tnow: number };
  precision: { b: number; tol: number; safety_margin?: number };
  policy_config?: PolicyConfig;
  model_pool?: unknown[];
  seed?: number;
}

export interface PolicyConfig {
  spectral_radius_max?: number;
  cond_limit?: number;
  dual_error_tol?: number;
  spectral_tail_tol?: number;
}

export const jobsTable = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
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
