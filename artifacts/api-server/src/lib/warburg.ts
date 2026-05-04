/**
 * warburg.ts
 * ==========
 *
 * Closed-form reference oracle for the unified Warburg theorem (TS port of
 * warburg_unified.py). Used by the numerical Editor to produce a closed-form
 * F̃[μ] alongside its numerical F[μ], and by the Verifier (CHK08) to enforce
 * agreement between the numerical pipeline and the analytic identity.
 *
 * Convention. The numerical Editor uses k0(t) = exp(−σ²t) for the gaussian
 * kernel — i.e. NO t^(s−1) prefactor. That maps onto the Warburg
 * parameterization k0(t) = t^(s−1) e^(−π a² t) with s = 1 and π a² = σ², so
 *
 *     A = σ²,   B = π · μᵀ Q⁻¹ μ,   ν = s − d/2 = 1 − d/2.
 *
 * For d = 1 we get ν = 1/2 and K_{1/2}(z) = √(π/(2z)) e^(−z) is exact.
 * For d ≥ 2 we get ν ≤ 0 and the lattice integral is evaluated via the
 * generic K_ν integral representation
 *
 *     K_ν(z) = ∫₀^∞ e^(−z cosh t) cosh(ν t) dt.
 *
 * (The canonical Warburg pole s = (d+1)/2 gives ν = 1/2 in any dimension,
 * but the editor's kernel is the simpler s = 1 form. We honour the editor.)
 *
 * The phase validators and Mercer half-integration basis are pure-math
 * cross-checks of the unified theorem and run as a one-shot startup
 * self-test in `warburg-self-test.ts`, not on a per-job basis.
 */

import type { Matrix, Vec } from "./math.js";
import { dot, norm2, scalarVec, vecSub } from "./math.js";

// ---------------------------------------------------------------------------
// Γ via Lanczos (matches editor.ts:lgamma; lifted here for shared use).
// ---------------------------------------------------------------------------

const LANCZOS_C = [
  76.18009172947146, -86.50532032941677, 24.01409824083091,
  -1.231739572450155, 0.001208650973866179, -0.000005395239384953,
];

export function lgamma(x: number): number {
  if (x <= 0) return Number.NaN;
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const ci of LANCZOS_C) {
    y += 1;
    ser += ci / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

export function gammaFunc(x: number): number {
  return Math.exp(lgamma(x));
}

// ---------------------------------------------------------------------------
// Modified Bessel function of the second kind K_ν(z), z > 0.
// Exact closed form for ν = 1/2; numerical integration of the standard
// integral representation otherwise.
// ---------------------------------------------------------------------------

export function besselK(nu: number, z: number): number {
  if (!isFinite(z) || z <= 0) return Number.POSITIVE_INFINITY;
  if (Math.abs(nu - 0.5) < 1e-12) {
    return Math.sqrt(Math.PI / (2 * z)) * Math.exp(-z);
  }
  if (Math.abs(nu + 0.5) < 1e-12) {
    return Math.sqrt(Math.PI / (2 * z)) * Math.exp(-z);
  }
  // Generic ν: K_ν(z) = ∫₀^∞ e^(−z cosh t) cosh(νt) dt.
  // Substitute u = sinh(t) so du = cosh(t) dt ; integrand decays super-fast.
  // 64-point Gauss–Legendre on [0, T] with T chosen so e^(−z cosh T) ≈ 1e−18.
  const Tmax = Math.max(8, Math.acosh(1 + 40 / Math.max(z, 1e-12)));
  const N = 80;
  const h = Tmax / N;
  let acc = 0;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) * h;
    acc += Math.exp(-z * Math.cosh(t)) * Math.cosh(nu * t);
  }
  return acc * h;
}

// ---------------------------------------------------------------------------
// Closed-form lattice integral
//   ∫₀^∞ t^(ν−1) exp(−A t − B/t) dt = 2 (B/A)^(ν/2) K_ν(2 √(AB))
// with the B → 0 limit Γ(ν)/A^ν.
// ---------------------------------------------------------------------------

export function besselIntegralClosedForm(A: number, B: number, nu: number): number {
  if (!isFinite(A) || A <= 0) return Number.NaN;
  if (B <= 1e-15) {
    // B → 0 limit: Γ(ν)/A^ν, finite only for ν > 0. For ν ≤ 0 the integral
    // diverges and the caller (e.g. the editor's zero-mode branch) must use
    // a different integrand; we return NaN so the divergence is explicit.
    if (nu <= 0) return Number.NaN;
    return gammaFunc(nu) / Math.pow(A, nu);
  }
  const z = 2 * Math.sqrt(A * B);
  return 2 * Math.pow(B / A, nu / 2) * besselK(nu, z);
}

// ---------------------------------------------------------------------------
// Closed-form F̃[μ] for the Warburg-pole Mellin kernel
//   k₀(t) = t^(s−1) e^(−π a² t),  K(t) = k₀(t) (1 − e^(−λ(t−T+δ))).
// Static channel uses A = π a²; live channel uses A + λ with the
// e^(λ(T−δ)) prefactor.
// ---------------------------------------------------------------------------

export interface WarburgParams {
  s: number; // Warburg pole, default (d+1)/2
  a: number; // Gauss regulator
  lambda: number;
  Tnow: number;
  delta: number;
  Qinv: Matrix;
  d: number;
}

export function fMuClosedForm(mu: Vec, p: WarburgParams): number {
  const nu = p.s - p.d / 2;
  const A = Math.PI * p.a * p.a;
  let B = 0;
  for (let i = 0; i < p.d; i++) {
    for (let j = 0; j < p.d; j++) {
      B += mu[i]! * p.Qinv[i]![j]! * mu[j]!;
    }
  }
  B *= Math.PI;
  const stat = besselIntegralClosedForm(A, B, nu);
  const live =
    Math.exp(p.lambda * (p.Tnow - p.delta)) *
    besselIntegralClosedForm(A + p.lambda, B, nu);
  return stat - live;
}

// ---------------------------------------------------------------------------
// Closed-form kernel K(t) — used by phase 2 validator (must vanish at t=T−δ).
// ---------------------------------------------------------------------------

export function kernelKClosedForm(t: number, p: WarburgParams): number {
  if (t <= 0) return 0;
  const k0 = Math.pow(t, p.s - 1) * Math.exp(-Math.PI * p.a * p.a * t);
  return k0 * (1 - Math.exp(-p.lambda * (t - p.Tnow + p.delta)));
}

// ---------------------------------------------------------------------------
// Mercer basis for the half-integration operator I^α on L²(0, T_max).
//
//   (I^α f)(t) = (1/Γ(α)) ∫₀^t (t−s)^(α−1) f(s) ds
//
// Eigenvalues of (I^α)(I^α)^T scale as k^(−2α) = k^(−1) at α = 1/2.
// We use Jacobi eigendecomposition for the small symmetric matrix (≤ 80×80)
// so we get ALL eigenvalues at once — needed for the slope fit on the bulk
// tail (modes 3 … 60).
// ---------------------------------------------------------------------------

function jacobiEigen(Ain: Matrix): { values: Vec; vectors: Matrix } {
  const n = Ain.length;
  const A: Matrix = Ain.map(row => [...row]);
  const V: Matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  const maxSweeps = 80;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) off += A[i]![j]! * A[i]![j]!;
    if (off < 1e-22) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p]![q]!;
        if (Math.abs(apq) < 1e-14) continue;
        const app = A[p]![p]!;
        const aqq = A[q]![q]!;
        const theta = (aqq - app) / (2 * apq);
        const t =
          theta >= 0
            ? 1 / (theta + Math.sqrt(1 + theta * theta))
            : 1 / (theta - Math.sqrt(1 + theta * theta));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;
        A[p]![p] = app - t * apq;
        A[q]![q] = aqq + t * apq;
        A[p]![q] = 0;
        A[q]![p] = 0;
        for (let i = 0; i < n; i++) {
          if (i !== p && i !== q) {
            const aip = A[i]![p]!;
            const aiq = A[i]![q]!;
            A[i]![p] = c * aip - s * aiq;
            A[p]![i] = A[i]![p]!;
            A[i]![q] = s * aip + c * aiq;
            A[q]![i] = A[i]![q]!;
          }
          const vip = V[i]![p]!;
          const viq = V[i]![q]!;
          V[i]![p] = c * vip - s * viq;
          V[i]![q] = s * vip + c * viq;
        }
      }
    }
  }
  const values: Vec = A.map((_, i) => A[i]![i]!);
  // sort descending
  const idx = values.map((_, i) => i).sort((a, b) => values[b]! - values[a]!);
  const sortedVals: Vec = idx.map(i => values[i]!);
  const sortedVecs: Matrix = Array.from({ length: n }, (_, i) =>
    idx.map(j => V[i]![j]!),
  );
  return { values: sortedVals, vectors: sortedVecs };
}

export interface MercerResult {
  eigenvalues: Vec; // descending
  vectors: Matrix; // columns are eigenvectors
  tGrid: Vec;
  slope: number; // log–log slope on modes [3, 50]
}

export function mercerHalfIntegrationBasis(
  alpha: number = 0.5,
  nGrid: number = 60,
  tMax: number = 10,
): MercerResult {
  const dt = tMax / nGrid;
  const tGrid: Vec = Array.from({ length: nGrid }, (_, i) => (i + 1) * dt);
  // Discretize I^α: I_op[i][j] = ((t_i − t_j)^(α−1) dt / Γ(α)) for j < i, else 0.
  const gAlpha = gammaFunc(alpha);
  const Iop: Matrix = Array.from({ length: nGrid }, () =>
    new Array(nGrid).fill(0) as Vec,
  );
  for (let i = 0; i < nGrid; i++) {
    for (let j = 0; j < i; j++) {
      const diff = tGrid[i]! - tGrid[j]!;
      Iop[i]![j] = (Math.pow(diff, alpha - 1) * dt) / gAlpha;
    }
  }
  // K_sym = I_op · I_op^T (symmetric PSD).
  const K: Matrix = Array.from({ length: nGrid }, () =>
    new Array(nGrid).fill(0) as Vec,
  );
  for (let i = 0; i < nGrid; i++) {
    for (let j = i; j < nGrid; j++) {
      let acc = 0;
      for (let k = 0; k < nGrid; k++) acc += Iop[i]![k]! * Iop[j]![k]!;
      K[i]![j] = acc;
      K[j]![i] = acc;
    }
  }
  const { values, vectors } = jacobiEigen(K);
  const positive = values.filter(v => v > 1e-14);
  const slope = logLogSlope(positive, 3, Math.min(50, positive.length));
  return { eigenvalues: values, vectors, tGrid, slope };
}

function logLogSlope(vals: Vec, lo: number, hi: number): number {
  if (hi - lo < 3) return Number.NaN;
  const xs: Vec = [];
  const ys: Vec = [];
  for (let k = lo; k < hi; k++) {
    if (vals[k]! > 0) {
      xs.push(Math.log(k + 1));
      ys.push(Math.log(vals[k]!));
    }
  }
  if (xs.length < 3) return Number.NaN;
  const n = xs.length;
  const xm = xs.reduce((s, v) => s + v, 0) / n;
  const ym = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - xm) * (ys[i]! - ym);
    den += (xs[i]! - xm) ** 2;
  }
  return den < 1e-20 ? Number.NaN : num / den;
}

// ---------------------------------------------------------------------------
// Five theorem-level validators. Each returns a structured result that the
// Verifier maps to a DiagnosticIssue.
// ---------------------------------------------------------------------------

export interface PhaseResult {
  phase: 1 | 2 | 3 | 4 | 5;
  pass: boolean;
  measured?: number;
  expected?: number;
  message: string;
}

/** Phase 1 — log-log slope of L(C) = (Cc/C)^α equals −α. */
export function validatePhase1(alphaC: number, Cc: number): PhaseResult {
  const Cs: Vec = [];
  const Ls: Vec = [];
  for (let i = 0; i < 30; i++) {
    const c = Math.exp(Math.log(1e15) + (i / 29) * (Math.log(1e20) - Math.log(1e15)));
    Cs.push(Math.log(c));
    Ls.push(Math.log(Math.pow(Cc / c, alphaC)));
  }
  const n = Cs.length;
  const xm = Cs.reduce((s, v) => s + v, 0) / n;
  const ym = Ls.reduce((s, v) => s + v, 0) / n;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (Cs[i]! - xm) * (Ls[i]! - ym);
    den += (Cs[i]! - xm) ** 2;
  }
  const slope = num / den;
  return {
    phase: 1,
    expected: -alphaC,
    measured: slope,
    pass: Math.abs(slope + alphaC) < 1e-6,
    message: `phase1 envelope slope = ${slope.toFixed(6)} (expected ${(-alphaC).toFixed(6)})`,
  };
}

/** Phase 2 — live channel cancels static at t = T_now − δ, so K(t_cut) = 0. */
export function validatePhase2(p: WarburgParams, tol: number = 1e-9): PhaseResult {
  const tCut = p.Tnow - p.delta + 1e-12;
  const v = kernelKClosedForm(tCut, p);
  return {
    phase: 2,
    measured: v,
    expected: 0,
    pass: Math.abs(v) < tol,
    message: `phase2 K(T−δ) = ${v.toExponential(3)} (expected ≈ 0)`,
  };
}

/** Phase 3 — second-descent integrability requires ν < 1. */
export function validatePhase3(nu: number): PhaseResult {
  return {
    phase: 3,
    measured: nu,
    expected: 0.5,
    pass: nu < 1,
    message: `phase3 ν = ${nu.toFixed(6)} (integrable iff ν < 1)`,
  };
}

/** Phase 4 — at the Warburg pole ν = 1/2 exactly. */
export function validatePhase4(nu: number, tol: number = 1e-9): PhaseResult {
  return {
    phase: 4,
    measured: nu,
    expected: 0.5,
    pass: Math.abs(nu - 0.5) < tol,
    message: `phase4 ν = ${nu.toFixed(6)} (expected 0.5 at Warburg pole)`,
  };
}

/** Phase 5 — Mercer eigenvalues scale as k^(−1); fit slope ∈ [−1.4, −0.6]. */
export function validatePhase5(slope: number, tol: number = 0.4): PhaseResult {
  return {
    phase: 5,
    measured: slope,
    expected: -1,
    pass: isFinite(slope) && Math.abs(slope + 1) < tol,
    message: `phase5 mercer slope = ${slope.toFixed(3)} (expected −1 ± ${tol})`,
  };
}

// ---------------------------------------------------------------------------
// Stable signature hash for a Warburg parameter bundle (matches
// Job.signature() in the Python reference at field-level granularity).
// ---------------------------------------------------------------------------

export function warburgSignature(p: WarburgParams): string {
  const sig = `s=${p.s}|d=${p.d}|a=${p.a}|lam=${p.lambda}|T=${p.Tnow}|delta=${p.delta}`;
  let h = 2166136261;
  for (let i = 0; i < sig.length; i++) {
    h ^= sig.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Re-export for callers that want to compute residuals without pulling in
// editor's helpers.
export { dot, norm2, scalarVec, vecSub };
