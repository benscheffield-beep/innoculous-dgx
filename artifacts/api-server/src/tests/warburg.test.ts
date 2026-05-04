import { describe, it, expect } from "vitest";
import {
  gammaFunc,
  besselK,
  besselIntegralClosedForm,
  fMuClosedForm,
  kernelKClosedForm,
  mercerHalfIntegrationBasis,
  validatePhase1,
  validatePhase2,
  validatePhase3,
  validatePhase4,
  validatePhase5,
  warburgSignature,
  type WarburgParams,
} from "../lib/warburg.js";
import { runVerifier, DEFAULT_POLICY, computeArtifactHash } from "../workers/verifier.js";
import type { NumericalArtifactPayload } from "@workspace/db";

function defaultParams(): WarburgParams {
  // Editor convention: s=1 (no t^(s-1) prefactor in k0); ν = 1 - d/2.
  return {
    s: 1,
    a: 1.0,
    lambda: 0.8,
    Tnow: 1.0,
    delta: 0.1,
    Qinv: [
      [1, 0],
      [0, 1],
    ],
    d: 2,
  };
}

describe("warburg / Gamma", () => {
  it("Gamma at integers matches factorials", () => {
    expect(gammaFunc(1)).toBeCloseTo(1, 6);
    expect(gammaFunc(2)).toBeCloseTo(1, 6);
    expect(gammaFunc(3)).toBeCloseTo(2, 6);
    expect(gammaFunc(5)).toBeCloseTo(24, 4);
  });

  it("Gamma(1/2) = sqrt(pi)", () => {
    expect(gammaFunc(0.5)).toBeCloseTo(Math.sqrt(Math.PI), 6);
  });
});

describe("warburg / besselK", () => {
  it("K_{1/2}(z) = sqrt(pi/(2z)) e^{-z}", () => {
    for (const z of [0.1, 0.5, 1.0, 2.5, 5.0, 10.0]) {
      const exact = Math.sqrt(Math.PI / (2 * z)) * Math.exp(-z);
      expect(besselK(0.5, z)).toBeCloseTo(exact, 10);
    }
  });

  it("K_0(z) matches reference values within 1e-4", () => {
    // Reference: Abramowitz & Stegun 9.8 / scipy.special.kv(0, z)
    const refs: Array<[number, number]> = [
      [0.5, 0.92441907],
      [1.0, 0.42102443],
      [2.0, 0.11389387],
      [4.0, 0.01115968],
    ];
    for (const [z, expected] of refs) {
      expect(besselK(0, z)).toBeCloseTo(expected, 3);
    }
  });
});

describe("warburg / besselIntegralClosedForm", () => {
  it("matches a numerical integration of t^(nu-1) exp(-At - B/t)", () => {
    const A = 1.5;
    const B = 0.7;
    const nu = 0.5;
    const closed = besselIntegralClosedForm(A, B, nu);
    let numeric = 0;
    const N = 20000;
    const T = 30;
    const dt = T / N;
    for (let i = 1; i <= N; i++) {
      const t = i * dt;
      numeric += Math.pow(t, nu - 1) * Math.exp(-A * t - B / t) * dt;
    }
    expect(closed).toBeCloseTo(numeric, 4);
  });

  it("B->0 limit equals Gamma(nu)/A^nu", () => {
    const A = 2.0;
    const nu = 0.75;
    const limit = gammaFunc(nu) / Math.pow(A, nu);
    expect(besselIntegralClosedForm(A, 0, nu)).toBeCloseTo(limit, 8);
  });
});

describe("warburg / fMuClosedForm", () => {
  it("yields finite values across the non-zero lattice", () => {
    // μ=[0,0] is the singular zero-mode (B=0 with ν=0 in d=2); the editor
    // handles it with a separate integrand and the oracle skips it.
    const p = defaultParams();
    for (const mu of [
      [1, 0],
      [0, 2],
      [-1, 1],
      [3, -2],
    ]) {
      const v = fMuClosedForm(mu, p);
      expect(isFinite(v)).toBe(true);
    }
  });

  it("returns NaN for the zero mode at d=2 (signals divergence)", () => {
    const p = defaultParams();
    expect(isFinite(fMuClosedForm([0, 0], p))).toBe(false);
  });

  it("static channel dominates as lambda -> 0", () => {
    const p = defaultParams();
    const fLive = fMuClosedForm([1, 1], p);
    const fStatic = fMuClosedForm([1, 1], { ...p, lambda: 1e-9 });
    // With lambda nearly zero, live ~ static, so fMu ~ 0
    expect(Math.abs(fStatic)).toBeLessThan(Math.abs(fLive) * 0.5 + 1e-6);
  });
});

describe("warburg / kernelKClosedForm — phase 2 cancellation", () => {
  it("vanishes at t = T_now - delta", () => {
    const p = defaultParams();
    const v = kernelKClosedForm(p.Tnow - p.delta, p);
    expect(Math.abs(v)).toBeLessThan(1e-12);
  });

  it("is non-zero away from the cutoff", () => {
    const p = defaultParams();
    expect(Math.abs(kernelKClosedForm(p.Tnow + 1.0, p))).toBeGreaterThan(0);
  });
});

describe("warburg / Mercer half-integration basis", () => {
  it("eigenvalues decay roughly as k^(-1) at alpha=1/2", () => {
    const r = mercerHalfIntegrationBasis(0.5, 60, 10);
    expect(r.eigenvalues.length).toBe(60);
    // top eigenvalue dominates
    expect(r.eigenvalues[0]!).toBeGreaterThan(r.eigenvalues[10]!);
    expect(Math.abs(r.slope + 1)).toBeLessThan(0.4);
  });
});

describe("warburg / phase validators", () => {
  it("phase 1 envelope slope = -alpha", () => {
    const r = validatePhase1(0.5, 1e10);
    expect(r.pass).toBe(true);
    expect(r.measured!).toBeCloseTo(-0.5, 6);
  });

  it("phase 2 K(T-delta) = 0", () => {
    expect(validatePhase2(defaultParams()).pass).toBe(true);
  });

  it("phase 3 ν<1 integrability holds at default", () => {
    expect(validatePhase3(0.5).pass).toBe(true);
    expect(validatePhase3(1.5).pass).toBe(false);
  });

  it("phase 4 ν=1/2 at the Warburg pole (d=1 case)", () => {
    expect(validatePhase4(0.5).pass).toBe(true);
    expect(validatePhase4(0.6).pass).toBe(false);
  });

  it("phase 5 mercer slope ≈ −1", () => {
    const m = mercerHalfIntegrationBasis(0.5);
    expect(validatePhase5(m.slope).pass).toBe(true);
    expect(validatePhase5(2.0).pass).toBe(false);
  });
});

describe("warburg / signature", () => {
  it("is stable across calls with identical parameters", () => {
    const p = defaultParams();
    expect(warburgSignature(p)).toBe(warburgSignature(p));
  });

  it("changes when any parameter changes", () => {
    const p = defaultParams();
    expect(warburgSignature(p)).not.toBe(warburgSignature({ ...p, lambda: 1.0 }));
  });
});

describe("verifier / Warburg checks (CHK08–CHK12)", () => {
  function basePayload(diagOverrides: Partial<NumericalArtifactPayload["diagnostics"]> = {}): NumericalArtifactPayload {
    return {
      kind: "numerical",
      dual_indices: [[0, 0]],
      F: { "0,0": 1 },
      S: { "0,0": 0.5 },
      Phi_coeffs: [0.1],
      R_coeffs: [0.05],
      U_meta: { basis: [[1]], eigenvalues: [1] },
      diagnostics: {
        spectral_radius: 0.5,
        cond_I_minus_G: 2,
        dual_truncation_error: 0,
        spectral_tail_error: 0,
        warburg_nu: 0.5,
        closed_form_residual: 0.001,
        mercer_slope: -1.0,
        kernel_cutoff_value: 0,
        ...diagOverrides,
      },
    };
  }

  it("CHK08 warns when closed-form residual exceeds tol", async () => {
    const p = basePayload({ closed_form_residual: 0.5 });
    const r = await runVerifier(p, computeArtifactHash(p));
    expect(r.issues.some(i => i.check_id === "CHK08")).toBe(true);
    expect(r.verdict).not.toBe("fail");
  });

  it("CHK10 warns when nu >= 1 (non-integrable)", async () => {
    const p = basePayload({ warburg_nu: 1.2 });
    const r = await runVerifier(p, computeArtifactHash(p));
    expect(r.issues.some(i => i.check_id === "CHK10")).toBe(true);
  });

  it("CHK12 warns when mercer slope is far from -1", async () => {
    const p = basePayload({ mercer_slope: 0.2 });
    const r = await runVerifier(p, computeArtifactHash(p));
    expect(r.issues.some(i => i.check_id === "CHK12")).toBe(true);
  });

  it("Warburg checks are silently skipped when diagnostics are null", async () => {
    const p = basePayload({
      warburg_nu: null,
      closed_form_residual: null,
      mercer_slope: null,
      kernel_cutoff_value: null,
    });
    const r = await runVerifier(p, computeArtifactHash(p));
    const warburgIssues = r.issues.filter(i =>
      ["CHK08", "CHK10", "CHK12"].includes(i.check_id),
    );
    expect(warburgIssues).toHaveLength(0);
    expect(r.verdict).toBe("pass");
  });

  it("custom warburg_residual_tol overrides DEFAULT_POLICY", async () => {
    const p = basePayload({ closed_form_residual: 0.1 });
    const lax = await runVerifier(p, computeArtifactHash(p), { warburg_residual_tol: 0.5 });
    const strict = await runVerifier(p, computeArtifactHash(p), { warburg_residual_tol: 0.001 });
    expect(lax.issues.some(i => i.check_id === "CHK08")).toBe(false);
    expect(strict.issues.some(i => i.check_id === "CHK08")).toBe(true);
    expect(DEFAULT_POLICY.warburg_residual_tol).toBeGreaterThan(0);
  });

  it("regression: removed CHK09 and CHK11 are never emitted by the verifier", async () => {
    const stressPayloads = [
      basePayload({ warburg_nu: 0.5, kernel_cutoff_value: 0 }),
      basePayload({ warburg_nu: 0.0, kernel_cutoff_value: 0.5 }),
      basePayload({ warburg_nu: 1.5, kernel_cutoff_value: -0.3 }),
      basePayload({ warburg_nu: -2.0, kernel_cutoff_value: 1e-3 }),
      basePayload({ warburg_nu: null, kernel_cutoff_value: null }),
    ];
    for (const p of stressPayloads) {
      const r = await runVerifier(p, computeArtifactHash(p));
      expect(r.issues.some(i => i.check_id === "CHK09")).toBe(false);
      expect(r.issues.some(i => i.check_id === "CHK11")).toBe(false);
    }
  });
});
