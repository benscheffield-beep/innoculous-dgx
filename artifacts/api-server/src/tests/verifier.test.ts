import { describe, it, expect, beforeEach } from "vitest";
import { runVerifier, computeArtifactHash, DEFAULT_POLICY } from "../workers/verifier.js";
import type { NumericalArtifactPayload as ArtifactPayload } from "@workspace/db";

function makeValidPayload(overrides: Partial<ArtifactPayload> = {}): ArtifactPayload {
  return {
    dual_indices: [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]],
    F: { "1,0": 0.123, "-1,0": 0.123, "0,1": 0.456, "0,-1": 0.456 },
    S: { "1,0": 0.05, "-1,0": 0.05, "0,1": 0.07, "0,-1": 0.07 },
    Phi_coeffs: [0.1, 0.2, 0.15],
    R_coeffs: [0.02, 0.01, 0.005],
    U_meta: {
      basis: [[1, 0, 0, 0, 0], [0, 1, 0, 0, 0], [0, 0, 1, 0, 0]],
      eigenvalues: [0.9, 0.5, 0.3],
    },
    diagnostics: {
      spectral_radius: 0.5,
      cond_I_minus_G: 2.0,
      dual_truncation_error: 1e-8,
      spectral_tail_error: 1e-9,
    },
    ...overrides,
  };
}

describe("Verifier CHK01 – artifact integrity", () => {
  it("passes when hash matches", async () => {
    const payload = makeValidPayload();
    const hash = computeArtifactHash(payload);
    const result = await runVerifier(payload, hash);
    const chk01 = result.issues.find(i => i.check_id === "CHK01");
    expect(chk01).toBeUndefined();
  });

  it("fails when hash is tampered", async () => {
    const payload = makeValidPayload();
    const result = await runVerifier(payload, "00000000deadbeef");
    const chk01 = result.issues.find(i => i.check_id === "CHK01");
    expect(chk01).toBeDefined();
    expect(chk01!.severity).toBe("fail");
    expect(result.verdict).toBe("fail");
  });
});

describe("Verifier CHK02 – spectral radius", () => {
  it("fails when spectral_radius >= max", async () => {
    const payload = makeValidPayload({ diagnostics: { spectral_radius: 1.0, cond_I_minus_G: 2, dual_truncation_error: 0, spectral_tail_error: 0 } });
    const hash = computeArtifactHash(payload);
    const result = await runVerifier(payload, hash);
    const chk02 = result.issues.find(i => i.check_id === "CHK02");
    expect(chk02).toBeDefined();
    expect(chk02!.severity).toBe("fail");
  });

  it("passes when spectral_radius is within bounds", async () => {
    const payload = makeValidPayload({ diagnostics: { spectral_radius: 0.5, cond_I_minus_G: 2, dual_truncation_error: 0, spectral_tail_error: 0 } });
    const hash = computeArtifactHash(payload);
    const result = await runVerifier(payload, hash);
    const chk02 = result.issues.find(i => i.check_id === "CHK02");
    expect(chk02).toBeUndefined();
  });
});

describe("Verifier CHK03 – condition number", () => {
  it("warns when cond_I_minus_G exceeds limit", async () => {
    const payload = makeValidPayload({ diagnostics: { spectral_radius: 0.5, cond_I_minus_G: 2_000_000, dual_truncation_error: 0, spectral_tail_error: 0 } });
    const hash = computeArtifactHash(payload);
    const result = await runVerifier(payload, hash);
    const chk03 = result.issues.find(i => i.check_id === "CHK03");
    expect(chk03).toBeDefined();
    expect(chk03!.severity).toBe("warn");
    expect(result.verdict).toBe("warn");
  });
});

describe("Verifier CHK04 – dual truncation error", () => {
  it("warns when dual_truncation_error is too large", async () => {
    const payload = makeValidPayload({ diagnostics: { spectral_radius: 0.5, cond_I_minus_G: 2, dual_truncation_error: 0.01, spectral_tail_error: 0 } });
    const hash = computeArtifactHash(payload);
    const result = await runVerifier(payload, hash);
    const chk04 = result.issues.find(i => i.check_id === "CHK04");
    expect(chk04).toBeDefined();
    expect(chk04!.severity).toBe("warn");
  });
});

describe("Verifier CHK05 – spectral tail", () => {
  it("warns when spectral_tail_error is too large", async () => {
    const payload = makeValidPayload({ diagnostics: { spectral_radius: 0.5, cond_I_minus_G: 2, dual_truncation_error: 0, spectral_tail_error: 0.01 } });
    const hash = computeArtifactHash(payload);
    const result = await runVerifier(payload, hash);
    const chk05 = result.issues.find(i => i.check_id === "CHK05");
    expect(chk05).toBeDefined();
    expect(chk05!.severity).toBe("warn");
  });
});

describe("Verifier CHK06 – causality", () => {
  it("fails when Phi_coeffs is empty", async () => {
    const payload = makeValidPayload({ Phi_coeffs: [] });
    const hash = computeArtifactHash(payload);
    const result = await runVerifier(payload, hash);
    const chk06 = result.issues.find(i => i.check_id === "CHK06");
    expect(chk06).toBeDefined();
    expect(chk06!.severity).toBe("fail");
  });

  it("fails when Phi_coeffs contains non-finite values", async () => {
    const payload = makeValidPayload({ Phi_coeffs: [NaN, 0.2] });
    const hash = computeArtifactHash(payload);
    const result = await runVerifier(payload, hash);
    const chk06 = result.issues.find(i => i.check_id === "CHK06");
    expect(chk06).toBeDefined();
    expect(chk06!.severity).toBe("fail");
  });

  it("passes with valid coefficients", async () => {
    const payload = makeValidPayload();
    const hash = computeArtifactHash(payload);
    const result = await runVerifier(payload, hash);
    const chk06 = result.issues.find(i => i.check_id === "CHK06");
    expect(chk06).toBeUndefined();
  });
});

describe("Verifier CHK07 – privacy", () => {
  it("fails when unexpected fields are present", async () => {
    const payload = { ...makeValidPayload(), user_email: "hidden@test.com" } as unknown as ArtifactPayload;
    const hash = computeArtifactHash(payload);
    const result = await runVerifier(payload, hash);
    const chk07 = result.issues.find(i => i.check_id === "CHK07");
    expect(chk07).toBeDefined();
    expect(chk07!.severity).toBe("fail");
  });

  it("passes with only allowed fields", async () => {
    const payload = makeValidPayload();
    const hash = computeArtifactHash(payload);
    const result = await runVerifier(payload, hash);
    const chk07 = result.issues.find(i => i.check_id === "CHK07");
    expect(chk07).toBeUndefined();
  });
});

describe("Verifier verdict aggregation", () => {
  it("returns pass when all checks pass", async () => {
    const payload = makeValidPayload();
    const hash = computeArtifactHash(payload);
    const result = await runVerifier(payload, hash);
    expect(result.verdict).toBe("pass");
    expect(result.signed_proof).toBeTruthy();
    expect(result.signed_proof.length).toBe(64);
  });

  it("returns fail when any fail check triggers", async () => {
    const payload = makeValidPayload({ Phi_coeffs: [] });
    const hash = computeArtifactHash(payload);
    const result = await runVerifier(payload, hash);
    expect(result.verdict).toBe("fail");
  });

  it("includes recomputed_metrics in result", async () => {
    const payload = makeValidPayload();
    const hash = computeArtifactHash(payload);
    const result = await runVerifier(payload, hash);
    expect(result.recomputed_metrics.spectral_radius).toBe(0.5);
    expect(result.recomputed_metrics.cond_number).toBe(2.0);
  });

  it("respects policy overrides", async () => {
    const payload = makeValidPayload({ diagnostics: { spectral_radius: 0.9, cond_I_minus_G: 2, dual_truncation_error: 0, spectral_tail_error: 0 } });
    const hash = computeArtifactHash(payload);
    const defaultResult = await runVerifier(payload, hash);
    const customResult = await runVerifier(payload, hash, { spectral_radius_max: 0.95 });
    expect(defaultResult.issues.some(i => i.check_id === "CHK02")).toBe(false);
    expect(customResult.issues.some(i => i.check_id === "CHK02")).toBe(false);
    const strictResult = await runVerifier(payload, hash, { spectral_radius_max: 0.85 });
    expect(strictResult.issues.some(i => i.check_id === "CHK02")).toBe(true);
  });
});
