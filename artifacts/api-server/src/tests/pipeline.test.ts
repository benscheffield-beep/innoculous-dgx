import { describe, it, expect } from "vitest";
import { runEditor } from "../workers/editor.js";
import { runVerifier, computeArtifactHash } from "../workers/verifier.js";
import type { JobDescriptor } from "@workspace/db";

const GAUSSIAN_2D: JobDescriptor = {
  kernel: { type: "gaussian", sigma: 1.0 },
  Q: [[1, 0], [0, 1]],
  truncation: { M: 2, r: 3 },
  latency: { lambda: 0.5, delta: 0.1, Tnow: 0 },
  precision: { b: 53, tol: 1e-6, safety_margin: 1e-3 },
  policy_config: {
    spectral_radius_max: 0.999,
    cond_limit: 1e6,
    dual_error_tol: 1e-4,
    spectral_tail_tol: 1e-4,
  },
};

const MELLIN_2D: JobDescriptor = {
  kernel: { type: "mellin", alpha: 0.5 },
  Q: [[2, 0], [0, 2]],
  truncation: { M: 1, r: 2 },
  latency: { lambda: 1.0, delta: 0.2, Tnow: 0.05 },
  precision: { b: 53, tol: 1e-5, safety_margin: 0.01 },
};

describe("Editor pipeline — Gaussian kernel 2D", () => {
  it("runs without throwing", async () => {
    await expect(runEditor(GAUSSIAN_2D)).resolves.toBeDefined();
  });

  it("produces expected artifact structure", async () => {
    const { artifact } = await runEditor(GAUSSIAN_2D);
    expect(artifact.dual_indices).toBeDefined();
    expect(artifact.dual_indices.length).toBeGreaterThan(0);
    expect(artifact.Phi_coeffs).toBeDefined();
    expect(artifact.R_coeffs).toBeDefined();
    expect(artifact.U_meta.basis).toBeDefined();
    expect(artifact.U_meta.eigenvalues).toBeDefined();
  });

  it("enumerates correct number of dual indices for M=2 in 2D Q=I", async () => {
    const { artifact } = await runEditor(GAUSSIAN_2D);
    const indices = artifact.dual_indices;
    expect(indices.length).toBeGreaterThanOrEqual(9);
    expect(indices.length).toBeLessThanOrEqual(13);
  });

  it("spectral_radius is < 1 (contractive absorber)", async () => {
    const { artifact } = await runEditor(GAUSSIAN_2D);
    expect(artifact.diagnostics.spectral_radius).toBeLessThan(1);
  });

  it("all diagnostics are finite numbers", async () => {
    const { artifact } = await runEditor(GAUSSIAN_2D);
    const { spectral_radius, cond_I_minus_G, dual_truncation_error, spectral_tail_error } =
      artifact.diagnostics;
    expect(isFinite(spectral_radius)).toBe(true);
    expect(isFinite(cond_I_minus_G)).toBe(true);
    expect(isFinite(dual_truncation_error)).toBe(true);
    expect(isFinite(spectral_tail_error)).toBe(true);
  });

  it("Phi_coeffs has length equal to truncation r", async () => {
    const { artifact } = await runEditor(GAUSSIAN_2D);
    expect(artifact.Phi_coeffs.length).toBe(GAUSSIAN_2D.truncation.r);
  });

  it("R_coeffs has length equal to truncation r", async () => {
    const { artifact } = await runEditor(GAUSSIAN_2D);
    expect(artifact.R_coeffs.length).toBe(GAUSSIAN_2D.truncation.r);
  });

  it("F map contains only numeric values", async () => {
    const { artifact } = await runEditor(GAUSSIAN_2D);
    for (const [, v] of Object.entries(artifact.F)) {
      expect(typeof v).toBe("number");
      expect(isNaN(v)).toBe(false);
    }
  });
});

describe("Editor pipeline — Mellin kernel 2D", () => {
  it("runs without throwing", async () => {
    await expect(runEditor(MELLIN_2D)).resolves.toBeDefined();
  });

  it("produces valid diagnostics", async () => {
    const { artifact } = await runEditor(MELLIN_2D);
    expect(artifact.diagnostics.spectral_radius).toBeLessThan(1);
  });
});

describe("Full pipeline: Editor → Verifier", () => {
  it("editor output passes verifier with gaussian kernel", async () => {
    const { artifact } = await runEditor(GAUSSIAN_2D);
    const hash = computeArtifactHash(artifact);
    const verifierResult = await runVerifier(artifact, hash);
    expect(["pass", "warn"]).toContain(verifierResult.verdict);
    expect(verifierResult.signed_proof).toBeTruthy();
    expect(verifierResult.signed_proof.length).toBe(64);
  });

  it("verifier never produces CHK01 failure on fresh editor output", async () => {
    const { artifact } = await runEditor(GAUSSIAN_2D);
    const hash = computeArtifactHash(artifact);
    const { issues } = await runVerifier(artifact, hash);
    const chk01 = issues.find(i => i.check_id === "CHK01");
    expect(chk01).toBeUndefined();
  });

  it("verifier never produces CHK06 failure on valid editor output", async () => {
    const { artifact } = await runEditor(GAUSSIAN_2D);
    const hash = computeArtifactHash(artifact);
    const { issues } = await runVerifier(artifact, hash);
    const chk06 = issues.find(i => i.check_id === "CHK06");
    expect(chk06).toBeUndefined();
  });

  it("verifier never produces CHK07 failure on fresh editor output", async () => {
    const { artifact } = await runEditor(GAUSSIAN_2D);
    const hash = computeArtifactHash(artifact);
    const { issues } = await runVerifier(artifact, hash);
    const chk07 = issues.find(i => i.check_id === "CHK07");
    expect(chk07).toBeUndefined();
  });

  it("signed_proof is deterministic for same key and same artifact", async () => {
    const { artifact } = await runEditor(GAUSSIAN_2D);
    const hash = computeArtifactHash(artifact);
    const r1 = await runVerifier(artifact, hash);
    const r2 = await runVerifier(artifact, hash);
    expect(r1.signed_proof).toBe(r2.signed_proof);
  });

  it("mellin kernel pipeline passes verifier", async () => {
    const { artifact } = await runEditor(MELLIN_2D);
    const hash = computeArtifactHash(artifact);
    const result = await runVerifier(artifact, hash);
    expect(["pass", "warn"]).toContain(result.verdict);
  });
});

describe("Model pool integration", () => {
  it("uses model_pool when provided", async () => {
    const descriptorWithPool: JobDescriptor = {
      ...GAUSSIAN_2D,
      model_pool: [
        [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
        [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
        [0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1],
      ],
    };
    const { artifact } = await runEditor(descriptorWithPool);
    expect(artifact.Phi_coeffs.length).toBe(GAUSSIAN_2D.truncation.r);
    expect(artifact.U_meta.basis.length).toBeGreaterThan(0);
  });
});
