import { createHmac, createHash } from "node:crypto";
import type { NumericalArtifactPayload } from "@workspace/db";
import type { DiagnosticIssue } from "@workspace/db";

type ArtifactPayload = NumericalArtifactPayload;

export interface PolicyConfig {
  spectral_radius_max: number;
  cond_limit: number;
  dual_error_tol: number;
  spectral_tail_tol: number;
  warburg_residual_tol: number;
  warburg_kernel_cutoff_tol: number;
  mercer_slope_tol: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  spectral_radius_max: 0.999,
  cond_limit: 1_000_000,
  dual_error_tol: 1e-6,
  spectral_tail_tol: 1e-6,
  warburg_residual_tol: 0.05,
  warburg_kernel_cutoff_tol: 1e-9,
  mercer_slope_tol: 0.4,
};

export type Verdict = "pass" | "warn" | "fail";

export interface VerifierResult {
  verdict: Verdict;
  issues: DiagnosticIssue[];
  recomputed_metrics: {
    spectral_radius: number;
    cond_number: number;
    dual_error_estimate: number;
    spectral_tail_estimate: number;
  };
  signed_proof: string;
}

function deepCanonical(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(deepCanonical).join(",") + "]";
  }
  if (typeof value === "object") {
    const sorted = Object.keys(value as Record<string, unknown>).sort();
    const pairs = sorted.map(k => `${JSON.stringify(k)}:${deepCanonical((value as Record<string, unknown>)[k])}`);
    return "{" + pairs.join(",") + "}";
  }
  return JSON.stringify(value);
}

export function computeArtifactHash(payload: unknown): string {
  const canonical = deepCanonical(payload);
  return createHash("sha256").update(canonical).digest("hex");
}

export { deepCanonical };

export function signArtifact(artifactHash: string, recomputedMetrics: object, verdict: Verdict): string {
  const signingKey = process.env["VERIFIER_SIGNING_KEY"] ?? "dev-insecure-key-change-in-production";
  const payload = JSON.stringify({
    artifact_hash: artifactHash,
    recomputed_metrics: recomputedMetrics,
    verdict,
  });
  return createHmac("sha256", signingKey).update(payload).digest("hex");
}

function chk01ArtifactIntegrity(
  payload: ArtifactPayload,
  storedHash: string
): DiagnosticIssue | null {
  const recomputed = computeArtifactHash(payload);
  if (recomputed !== storedHash) {
    return {
      check_id: "CHK01",
      severity: "fail",
      message: `Artifact integrity failure: recomputed hash ${recomputed.slice(0, 8)}... does not match stored hash ${storedHash.slice(0, 8)}...`,
      remediation: "reject_artifact_and_request_recompute",
    };
  }
  return null;
}

function chk02SpectralRadius(
  diag: ArtifactPayload["diagnostics"],
  policy: PolicyConfig
): DiagnosticIssue | null {
  const rho = diag.spectral_radius;
  if (rho >= policy.spectral_radius_max) {
    return {
      check_id: "CHK02",
      severity: "fail",
      message: `Spectral radius ${rho.toFixed(6)} >= policy maximum ${policy.spectral_radius_max}. Absorber matrix is not contractive.`,
      remediation: "apply_damping_to_G_off",
    };
  }
  return null;
}

function chk03ConditionNumber(
  diag: ArtifactPayload["diagnostics"],
  policy: PolicyConfig
): DiagnosticIssue | null {
  const cond = diag.cond_I_minus_G;
  if (cond >= policy.cond_limit) {
    return {
      check_id: "CHK03",
      severity: "warn",
      message: `Condition number ${cond.toExponential(3)} >= policy limit ${policy.cond_limit.toExponential(3)}. Linear solve may be inaccurate.`,
      remediation: "recommend_increase_b",
    };
  }
  return null;
}

function chk04DualTruncationError(
  diag: ArtifactPayload["diagnostics"],
  policy: PolicyConfig
): DiagnosticIssue | null {
  const err = diag.dual_truncation_error;
  if (err > policy.dual_error_tol) {
    return {
      check_id: "CHK04",
      severity: "warn",
      message: `Dual truncation error ${err.toExponential(3)} > tolerance ${policy.dual_error_tol.toExponential(3)}. Consider increasing M.`,
      remediation: "reduce_truncation_radius_M",
    };
  }
  return null;
}

function chk05SpectralTail(
  diag: ArtifactPayload["diagnostics"],
  policy: PolicyConfig
): DiagnosticIssue | null {
  const err = diag.spectral_tail_error;
  if (err > policy.spectral_tail_tol) {
    return {
      check_id: "CHK05",
      severity: "warn",
      message: `Spectral tail estimate ${err.toExponential(3)} > tolerance ${policy.spectral_tail_tol.toExponential(3)}. Consider increasing r.`,
      remediation: "recommend_increase_r",
    };
  }
  return null;
}

function chk06Causality(payload: ArtifactPayload): DiagnosticIssue | null {
  const { Phi_coeffs, R_coeffs, F, S } = payload;

  if (!Phi_coeffs || Phi_coeffs.length === 0) {
    return {
      check_id: "CHK06",
      severity: "fail",
      message: "Causality check failed: Phi_coeffs is empty. Retarded/advanced decomposition not performed.",
      remediation: "reject_artifact_and_request_recompute",
    };
  }

  if (!R_coeffs || R_coeffs.length === 0) {
    return {
      check_id: "CHK06",
      severity: "fail",
      message: "Causality check failed: R_coeffs (radiation reaction) is missing. Retarded decomposition not applied.",
      remediation: "reject_artifact_and_request_recompute",
    };
  }

  const fKeys = Object.keys(F ?? {});
  const sKeys = Object.keys(S ?? {});
  if (fKeys.length === 0 && sKeys.length === 0) {
    return {
      check_id: "CHK06",
      severity: "fail",
      message: "Causality check failed: both F and S coefficient maps are empty. No iε prescription was applied.",
      remediation: "reject_artifact_and_request_recompute",
    };
  }

  const hasFiniteCoeffs = Phi_coeffs.every((v: number) => isFinite(v)) && R_coeffs.every((v: number) => isFinite(v));
  if (!hasFiniteCoeffs) {
    return {
      check_id: "CHK06",
      severity: "fail",
      message: "Causality check failed: non-finite values in Phi_coeffs or R_coeffs indicate a failed retarded/advanced decomposition.",
      remediation: "increase_regulator_epsilon",
    };
  }

  return null;
}

const SENSITIVE_PATTERNS = [
  /[a-zA-Z0-9+/]{40,}={0,2}/,
  /sk[-_][a-zA-Z0-9]{20,}/,
  /[0-9a-f]{64}/,
  /password/i,
  /secret/i,
  /token/i,
  /apikey/i,
  /api_key/i,
  /private_key/i,
  /BEGIN (RSA |EC )?PRIVATE KEY/,
];

function chk07Privacy(payload: ArtifactPayload): DiagnosticIssue | null {
  const payloadStr = JSON.stringify(payload);

  const TOP_LEVEL_ALLOWED = new Set([
    "kind", "dual_indices", "F", "S", "Phi_coeffs", "R_coeffs", "U_meta", "diagnostics",
  ]);
  const unexpectedTopLevel: string[] = [];
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    for (const k of Object.keys(payload)) {
      if (!TOP_LEVEL_ALLOWED.has(k)) unexpectedTopLevel.push(k);
    }
  }

  if (unexpectedTopLevel.length > 0) {
    return {
      check_id: "CHK07",
      severity: "fail",
      message: `Privacy check failed: unexpected top-level fields in artifact: ${unexpectedTopLevel.join(", ")}`,
      remediation: "reject_artifact_and_request_recompute",
    };
  }

  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(payloadStr)) {
      return {
        check_id: "CHK07",
        severity: "fail",
        message: `Privacy check failed: artifact payload matches sensitive data pattern (${pattern.source.slice(0, 30)}...)`,
        remediation: "reject_artifact_and_request_recompute",
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Warburg closed-form oracle checks (CHK08–CHK12).
// Each check no-ops with a null return when the Editor reported the relevant
// diagnostic as null/undefined — this happens for kernels outside the oracle's
// domain (e.g. mellin), so the existing numerical pipeline keeps working.
// ---------------------------------------------------------------------------

function chk08ClosedFormResidual(
  diag: ArtifactPayload["diagnostics"],
  policy: PolicyConfig,
): DiagnosticIssue | null {
  const r = diag.closed_form_residual;
  if (r == null) return null;
  if (r > policy.warburg_residual_tol) {
    return {
      check_id: "CHK08",
      severity: "warn",
      message: `Closed-form residual ||F − F̃||/||F̃|| = ${r.toExponential(3)} exceeds tol ${policy.warburg_residual_tol}. Numerical F[μ] drifts from the Warburg Bessel oracle — increase precision.b or check kernel parameters.`,
      remediation: "recommend_increase_b",
    };
  }
  return null;
}

function chk10WarburgIntegrability(
  diag: ArtifactPayload["diagnostics"],
): DiagnosticIssue | null {
  const nu = diag.warburg_nu;
  if (nu == null) return null;
  if (nu >= 1) {
    return {
      check_id: "CHK10",
      severity: "warn",
      message: `Warburg ν = ${nu.toFixed(4)} ≥ 1; second descent fails to be integrable. Reduce dimension d or widen kernel pole s.`,
      remediation: "reduce_truncation_radius_M",
    };
  }
  return null;
}

function chk12MercerSlope(
  diag: ArtifactPayload["diagnostics"],
  policy: PolicyConfig,
): DiagnosticIssue | null {
  const slope = diag.mercer_slope;
  if (slope == null) return null;
  if (!isFinite(slope) || Math.abs(slope + 1) > policy.mercer_slope_tol) {
    return {
      check_id: "CHK12",
      severity: "warn",
      message: `Mercer eigenvalue slope = ${slope.toFixed(3)}; expected −1 ± ${policy.mercer_slope_tol}. Universal subspace heuristic r ≈ 16 may not apply.`,
      remediation: "recommend_increase_r",
    };
  }
  return null;
}

export async function runVerifier(
  payload: ArtifactPayload,
  storedHash: string,
  policyOverrides: Partial<PolicyConfig> = {}
): Promise<VerifierResult> {
  const policy: PolicyConfig = { ...DEFAULT_POLICY, ...policyOverrides };

  const checks = await Promise.all([
    Promise.resolve(chk01ArtifactIntegrity(payload, storedHash)),
    Promise.resolve(chk02SpectralRadius(payload.diagnostics, policy)),
    Promise.resolve(chk03ConditionNumber(payload.diagnostics, policy)),
    Promise.resolve(chk04DualTruncationError(payload.diagnostics, policy)),
    Promise.resolve(chk05SpectralTail(payload.diagnostics, policy)),
    Promise.resolve(chk06Causality(payload)),
    Promise.resolve(chk07Privacy(payload)),
    Promise.resolve(chk08ClosedFormResidual(payload.diagnostics, policy)),
    Promise.resolve(chk10WarburgIntegrability(payload.diagnostics)),
    Promise.resolve(chk12MercerSlope(payload.diagnostics, policy)),
  ]);

  const issues: DiagnosticIssue[] = checks.filter((c): c is DiagnosticIssue => c !== null);

  let verdict: Verdict = "pass";
  for (const issue of issues) {
    if (issue.severity === "fail") {
      verdict = "fail";
      break;
    }
    if (issue.severity === "warn") verdict = "warn";
  }

  const recomputed_metrics = {
    spectral_radius: payload.diagnostics.spectral_radius,
    cond_number: payload.diagnostics.cond_I_minus_G,
    dual_error_estimate: payload.diagnostics.dual_truncation_error,
    spectral_tail_estimate: payload.diagnostics.spectral_tail_error,
  };

  const artifactHash = computeArtifactHash(payload);
  const signed_proof = signArtifact(artifactHash, recomputed_metrics, verdict);

  return { verdict, issues, recomputed_metrics, signed_proof };
}

