import { pgTable, uuid, integer, jsonb, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobsTable } from "./jobs";

export interface ArtifactPayload {
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
  };
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
