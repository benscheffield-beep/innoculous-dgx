import { pgTable, uuid, real, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobsTable } from "./jobs";
import { jobArtifactsTable } from "./job-artifacts";

export interface DiagnosticIssue {
  check_id: string;
  severity: "fail" | "warn";
  message: string;
  remediation: string;
}

export const jobDiagnosticsTable = pgTable("job_diagnostics", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobsTable.id),
  artifactId: uuid("artifact_id")
    .notNull()
    .references(() => jobArtifactsTable.id),
  spectralRadius: real("spectral_radius").notNull(),
  condIMinusG: real("cond_i_minus_g").notNull(),
  dualTruncationError: real("dual_truncation_error").notNull(),
  spectralTailError: real("spectral_tail_error").notNull(),
  verdict: text("verdict").notNull(),
  issues: jsonb("issues").$type<DiagnosticIssue[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertJobDiagnosticsSchema = createInsertSchema(jobDiagnosticsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertJobDiagnostics = z.infer<typeof insertJobDiagnosticsSchema>;
export type JobDiagnostics = typeof jobDiagnosticsTable.$inferSelect;
