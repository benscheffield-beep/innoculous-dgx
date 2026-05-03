import {
  type Matrix,
  type Vec,
  eye,
  iMinus,
  matVec,
  matMul,
  transpose,
  matInverse,
  spectralRadius,
  conditionNumber,
  dot,
  norm2,
  vecSub,
  scalarVec,
  integrateInfinite,
  matInverseQuadForm,
  topEigenvectors,
  gramSchmidt,
} from "../lib/math.js";
import type { KernelParams, NumericalDescriptor as JobDescriptor, NumericalArtifactPayload as ArtifactPayload } from "@workspace/db";

export interface EditorResult {
  artifact: ArtifactPayload;
}

function buildK0(kernel: KernelParams): (t: number) => number {
  if (kernel.type === "gaussian") {
    const sigma = kernel.sigma ?? 1.0;
    return (t: number) => Math.exp(-sigma * sigma * t);
  } else {
    const alpha = kernel.alpha ?? 0.5;
    return (t: number) => (t > 0 ? Math.pow(t, -alpha) : 0);
  }
}

function buildK(k0: (t: number) => number, latency: JobDescriptor["latency"]): (t: number) => number {
  const { lambda, delta, Tnow } = latency;
  return (t: number) => {
    const latencyFactor = 1 - Math.exp(-lambda * (t - Tnow + delta));
    return latencyFactor * k0(t);
  };
}

function enumerateDualIndices(M: number, Q: Matrix): number[][] {
  const d = Q.length;
  const Msq = M * M;
  const indices: number[][] = [];
  const range = Math.ceil(M) + 1;

  function recurse(dim: number, current: number[]): void {
    if (dim === d) {
      let normSq = 0;
      for (let i = 0; i < d; i++) {
        for (let j = 0; j < d; j++) {
          normSq += current[i]! * Q[i]![j]! * current[j]!;
        }
      }
      if (normSq <= Msq + 1e-10) indices.push([...current]);
      return;
    }
    for (let v = -range; v <= range; v++) {
      current.push(v);
      recurse(dim + 1, current);
      current.pop();
    }
  }
  recurse(0, []);
  return indices;
}

function computeQInverse(Q: Matrix): Matrix {
  return matInverse(Q);
}

function computeF(
  K: (t: number) => number,
  mu: Vec,
  Qinv: Matrix,
  d: number
): number {
  const quad = matInverseQuadForm(mu, Qinv);
  const isZeroMode = quad < 1e-14;

  if (isZeroMode) {
    return integrateInfinite((t: number) => {
      if (t < 1e-12) return 0;
      const kt = K(t);
      if (!isFinite(kt)) return 0;
      return kt * Math.pow(t, -d / 2 + 1);
    });
  }

  const beta = Math.PI * quad;
  return integrateInfinite((t: number) => {
    if (t < 1e-12) return 0;
    const kt = K(t);
    if (!isFinite(kt)) return 0;
    const exponent = -beta / t;
    if (exponent < -700) return 0;
    return kt * Math.pow(t, -d / 2) * Math.exp(exponent);
  });
}

function computeShortTimeCoefficients(k0: (t: number) => number, latency: JobDescriptor["latency"]): Vec {
  const { lambda, delta, Tnow } = latency;
  const t0 = Math.max(Tnow - delta, 0);
  const K0 = (1 - Math.exp(-lambda * (-Tnow + delta))) * k0(0);

  const eps = 1e-5;
  const K_eps = (1 - Math.exp(-lambda * (eps - Tnow + delta))) * k0(eps);
  const K_2eps = (1 - Math.exp(-lambda * (2 * eps - Tnow + delta))) * k0(2 * eps);

  const a0 = K0;
  const a1 = (K_eps - K0) / eps;
  const a2 = (K_2eps - 2 * K_eps + K0) / (eps * eps);

  return [a0, a1, a2];
}

function buildAbsorberMatrix(
  dualIndices: number[][],
  kernel: KernelParams,
  Q: Matrix,
  precision: JobDescriptor["precision"]
): Matrix {
  const n = dualIndices.length;
  const sigma = kernel.type === "gaussian" ? (kernel.sigma ?? 1.0) : 1.0;
  const scaleParam = 2 * sigma * sigma * Math.PI;
  const safetyMargin = precision.safety_margin ?? 1e-3;

  const raw: Matrix = Array.from({ length: n }, () => new Array(n).fill(0) as Vec);

  for (let i = 0; i < n; i++) {
    let rowSum = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const diff = dualIndices[i]!.map((v, k) => v - dualIndices[j]![k]!);
      let normSq = 0;
      for (let a = 0; a < Q.length; a++)
        for (let b = 0; b < Q.length; b++)
          normSq += diff[a]! * Q[a]![b]! * diff[b]!;
      const coupling = Math.exp(-scaleParam * normSq);
      raw[i]![j] = coupling;
      rowSum += coupling;
    }
    if (rowSum > 1e-14) {
      const targetSum = 0.85 * (1 - safetyMargin);
      const normalizer = rowSum / targetSum;
      for (let j = 0; j < n; j++) {
        if (i !== j) raw[i]![j]! /= normalizer;
      }
    }
  }
  return raw;
}

function computeDiracSubtraction(
  F: Map<string, number>,
  dualIndices: number[][],
  a: Vec,
  Q: Matrix
): Map<string, number> {
  const Qinv = computeQInverse(Q);
  const d = Q.length;
  const S = new Map<string, number>();

  for (const mu of dualIndices) {
    const key = mu.join(",");
    const fVal = F.get(key) ?? 0;
    const quad = matInverseQuadForm(mu, Qinv);
    const isZeroMode = quad < 1e-14;

    if (isZeroMode) {
      S.set(key, 0);
      continue;
    }

    const beta = Math.PI * quad;
    let fSym = 0;
    for (let k = 0; k < a.length; k++) {
      const nu = k - d / 2 + 1;
      if (Math.abs(nu) > 1e-10) {
        const gammaApprox = Math.exp(lgamma(nu));
        fSym += a[k]! * gammaApprox * Math.pow(beta, -nu);
      }
    }
    S.set(key, fVal - fSym);
  }
  return S;
}

function lgamma(x: number): number {
  if (x <= 0) return 0;
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.001208650973866179, -0.000005395239384953,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const ci of c) {
    y += 1;
    ser += ci / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function solveLinearSystem(
  G_off: Matrix,
  S: Map<string, number>,
  dualIndices: number[][],
  tol: number
): Map<string, number> {
  const n = dualIndices.length;
  const IminusG = iMinus(G_off);
  const sVec: Vec = dualIndices.map(mu => S.get(mu.join(",")) ?? 0);
  const phiVec = solveWithFallback(IminusG, sVec, tol);
  const result = new Map<string, number>();
  dualIndices.forEach((mu, i) => result.set(mu.join(","), phiVec[i]!));
  return result;
}

function solveWithFallback(A: Matrix, b: Vec, _tol: number): Vec {
  try {
    const Ainv = matInverse(A);
    return matVec(Ainv, b);
  } catch {
    const n = A.length;
    const fallback: Vec = new Array(n).fill(0) as Vec;
    const reg: Matrix = A.map((row, i) =>
      row.map((v, j) => v + (i === j ? 1e-8 : 0))
    );
    try {
      return matVec(matInverse(reg), b);
    } catch {
      return fallback;
    }
  }
}

function applyDamping(G_off: Matrix): void {
  const n = G_off.length;
  const rho = spectralRadius(G_off);
  if (rho < 1e-14) return;
  const dampFactor = 0.9 / rho;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      G_off[i]![j]! *= dampFactor;
}

function computeRetardedPart(
  F: Map<string, number>,
  dualIndices: number[][]
): Map<string, number> {
  const F_ret = new Map<string, number>();
  for (const mu of dualIndices) {
    const key = mu.join(",");
    const fVal = F.get(key) ?? 0;
    F_ret.set(key, fVal * 0.5);
  }
  return F_ret;
}

function projectToBasis(
  coeffMap: Map<string, number>,
  dualIndices: number[][],
  U: Matrix
): Vec {
  const vec: Vec = dualIndices.map(mu => coeffMap.get(mu.join(",")) ?? 0);
  return U.map(basisVec => dot(basisVec, vec));
}

function computeSpectralBasis(
  modelPool: unknown[] | undefined,
  r: number,
  n: number
): { U: Matrix; lambdas: Vec } {
  if (!modelPool || modelPool.length === 0) {
    const canonicalVecs = Array.from({ length: Math.min(r, n) }, (_, k) =>
      Array.from({ length: n }, (_, i) => (i === k ? 1 : 0))
    );
    return {
      U: canonicalVecs,
      lambdas: new Array(Math.min(r, n)).fill(1) as Vec,
    };
  }

  const vecs = modelPool
    .filter(m => Array.isArray(m))
    .map(m => (m as number[]).slice(0, n).concat(new Array(Math.max(0, n - (m as number[]).length)).fill(0) as Vec)) as Matrix;

  if (vecs.length < 2) {
    return computeSpectralBasis(undefined, r, n);
  }

  const cov: Matrix = Array.from({ length: n }, () => new Array(n).fill(0) as Vec);
  for (const v of vecs) {
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        cov[i]![j]! += v[i]! * v[j]!;
  }
  const scale = 1 / vecs.length;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      cov[i]![j]! *= scale;

  const { vectors, values } = topEigenvectors(cov, r);
  const U = gramSchmidt(vectors);
  return { U, lambdas: values.slice(0, U.length) };
}

function estimateDualError(F: Map<string, number>, M: number): number {
  let maxBoundary = 0;
  for (const [key, val] of F.entries()) {
    const mu = key.split(",").map(Number);
    const normSq = mu.reduce((s, v) => s + v * v, 0);
    if (Math.sqrt(normSq) > M * 0.9) {
      maxBoundary = Math.max(maxBoundary, Math.abs(val));
    }
  }
  return maxBoundary;
}

function estimateSpectralTail(lambdas: Vec, r: number): number {
  if (lambdas.length <= r) return 0;
  const tail = lambdas.slice(r);
  const total = lambdas.reduce((s, v) => s + Math.abs(v), 0) + 1e-30;
  return tail.reduce((s, v) => s + Math.abs(v), 0) / total;
}

function serializeSparse(map: Map<string, number>): Record<string, number> {
  const obj: Record<string, number> = {};
  for (const [k, v] of map.entries()) {
    if (Math.abs(v) > 1e-16) obj[k] = v;
  }
  return obj;
}

export async function runEditor(descriptor: JobDescriptor): Promise<EditorResult> {
  const { kernel, Q, truncation, latency, precision, model_pool } = descriptor;
  const d = Q.length;

  const k0 = buildK0(kernel);
  const K = buildK(k0, latency);
  const Qinv = computeQInverse(Q);
  const dualIndices = enumerateDualIndices(truncation.M, Q);

  const F = new Map<string, number>();
  for (const mu of dualIndices) {
    const key = mu.join(",");
    const val = computeF(K, mu, Qinv, d);
    F.set(key, val);
  }

  const a = computeShortTimeCoefficients(k0, latency);

  const G_off = buildAbsorberMatrix(dualIndices, kernel, Q, precision);

  const S = computeDiracSubtraction(F, dualIndices, a, Q);

  const rho = spectralRadius(G_off);
  const safetyMargin = precision.safety_margin ?? 1e-3;
  if (rho >= 1 - safetyMargin) {
    applyDamping(G_off);
  }

  const Phi = solveLinearSystem(G_off, S, dualIndices, precision.tol);

  const F_ret = computeRetardedPart(F, dualIndices);
  const R = new Map<string, number>();
  for (const mu of dualIndices) {
    const key = mu.join(",");
    R.set(key, (Phi.get(key) ?? 0) - (F_ret.get(key) ?? 0));
  }

  const n = dualIndices.length;
  const r = Math.min(truncation.r, n);
  const { U, lambdas } = computeSpectralBasis(model_pool, r, n);

  const coeffs_Phi = projectToBasis(Phi, dualIndices, U);
  const coeffs_R = projectToBasis(R, dualIndices, U);

  const finalRho = spectralRadius(G_off);
  const IminusG = iMinus(G_off);
  const cond = conditionNumber(IminusG);
  const dualTruncError = estimateDualError(F, truncation.M);
  const spectralTailErr = estimateSpectralTail(lambdas, r);

  const artifact: ArtifactPayload = {
    dual_indices: dualIndices,
    F: serializeSparse(F),
    S: serializeSparse(S),
    Phi_coeffs: coeffs_Phi,
    R_coeffs: coeffs_R,
    U_meta: { basis: U, eigenvalues: lambdas },
    diagnostics: {
      spectral_radius: finalRho,
      cond_I_minus_G: cond,
      dual_truncation_error: dualTruncError,
      spectral_tail_error: spectralTailErr,
    },
  };

  return { artifact };
}
