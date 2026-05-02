export type Matrix = number[][];
export type Vec = number[];

export function eye(n: number): Matrix {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

export function zeros(n: number): Vec {
  return new Array(n).fill(0) as Vec;
}

export function transpose(A: Matrix): Matrix {
  const m = A.length, n = A[0]!.length;
  return Array.from({ length: n }, (_, j) => Array.from({ length: m }, (_, i) => A[i]![j]!));
}

export function matMul(A: Matrix, B: Matrix): Matrix {
  const m = A.length, k = B.length, n = B[0]!.length;
  const C: Matrix = Array.from({ length: m }, () => new Array(n).fill(0) as Vec);
  for (let i = 0; i < m; i++)
    for (let j = 0; j < n; j++)
      for (let l = 0; l < k; l++)
        C[i]![j]! += A[i]![l]! * B[l]![j]!;
  return C;
}

export function matVec(A: Matrix, v: Vec): Vec {
  return A.map(row => row.reduce((s, a, j) => s + a * v[j]!, 0));
}

export function vecAdd(a: Vec, b: Vec): Vec {
  return a.map((v, i) => v + b[i]!);
}

export function vecSub(a: Vec, b: Vec): Vec {
  return a.map((v, i) => v - b[i]!);
}

export function scalarVec(s: number, v: Vec): Vec {
  return v.map(x => s * x);
}

export function dot(a: Vec, b: Vec): number {
  return a.reduce((s, v, i) => s + v * b[i]!, 0);
}

export function norm2(v: Vec): number {
  return Math.sqrt(dot(v, v));
}

export function matAdd(A: Matrix, B: Matrix): Matrix {
  return A.map((row, i) => row.map((v, j) => v + B[i]![j]!));
}

export function matSub(A: Matrix, B: Matrix): Matrix {
  return A.map((row, i) => row.map((v, j) => v - B[i]![j]!));
}

export function scalarMat(s: number, A: Matrix): Matrix {
  return A.map(row => row.map(v => s * v));
}

export function iMinus(A: Matrix): Matrix {
  return matSub(eye(A.length), A);
}

export function frobeniusNorm(A: Matrix): number {
  return Math.sqrt(A.reduce((s, row) => s + row.reduce((t, v) => t + v * v, 0), 0));
}

export function matInverse(A: Matrix): Matrix {
  const n = A.length;
  const aug: Matrix = A.map((row, i) =>
    [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]
  );
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let row = col + 1; row < n; row++)
      if (Math.abs(aug[row]![col]!) > Math.abs(aug[pivotRow]![col]!)) pivotRow = row;
    [aug[col], aug[pivotRow]] = [aug[pivotRow]!, aug[col]!];
    const pivot = aug[col]![col]!;
    if (Math.abs(pivot) < 1e-14) throw new Error("Matrix is singular or nearly singular");
    for (let j = col; j < 2 * n; j++) aug[col]![j]! /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row]![col]!;
      for (let j = col; j < 2 * n; j++) aug[row]![j]! -= factor * aug[col]![j]!;
    }
  }
  return aug.map(row => row.slice(n));
}

export function solve(A: Matrix, b: Vec): Vec {
  const n = A.length;
  const M: Matrix = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let row = col + 1; row < n; row++)
      if (Math.abs(M[row]![col]!) > Math.abs(M[pivotRow]![col]!)) pivotRow = row;
    [M[col], M[pivotRow]] = [M[pivotRow]!, M[col]!];
    const pivot = M[col]![col]!;
    if (Math.abs(pivot) < 1e-14) {
      for (let j = col; j <= n; j++) M[col]![j] = 0;
      continue;
    }
    for (let j = col; j <= n; j++) M[col]![j]! /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row]![col]!;
      for (let j = col; j <= n; j++) M[row]![j]! -= factor * M[col]![j]!;
    }
  }
  return M.map(row => row[n]!);
}

export function spectralRadius(A: Matrix): number {
  const n = A.length;
  if (n === 0) return 0;
  let v: Vec = Array.from({ length: n }, () => Math.random());
  let lambda = 0;
  for (let iter = 0; iter < 200; iter++) {
    const Av = matVec(A, v);
    const normAv = norm2(Av);
    if (normAv < 1e-15) return 0;
    lambda = normAv / norm2(v);
    v = scalarVec(1 / normAv, Av);
  }
  const Av = matVec(A, v);
  lambda = Math.abs(dot(v, Av));
  return lambda;
}

export function conditionNumber(A: Matrix): number {
  const n = A.length;
  if (n === 0) return 1;
  const ATA = matMul(transpose(A), A);
  const lambdaMax = spectralRadius(ATA);
  if (lambdaMax < 1e-30) return Infinity;
  const shift = lambdaMax * 1e-14;
  const shifted = ATA.map((row, i) => row.map((v, j) => v + (i === j ? shift : 0)));
  try {
    const inv = matInverse(shifted);
    const lambdaMinInv = spectralRadius(inv);
    const lambdaMin = lambdaMinInv < 1e-30 ? shift : 1 / lambdaMinInv;
    return Math.sqrt(lambdaMax / Math.max(lambdaMin, 1e-30));
  } catch {
    return Infinity;
  }
}

export function matQuadForm(v: Vec, Q: Matrix): number {
  return dot(v, matVec(Q, v));
}

export function matInverseQuadForm(mu: Vec, Qinv: Matrix): number {
  return matQuadForm(mu, Qinv);
}

const GL20_X = [
  -0.993128599, -0.963971927, -0.912234428, -0.839116972, -0.746331906,
  -0.636053681, -0.510867002, -0.373706089, -0.227785851, -0.076526521,
   0.076526521,  0.227785851,  0.373706089,  0.510867002,  0.636053681,
   0.746331906,  0.839116972,  0.912234428,  0.963971927,  0.993128599,
];
const GL20_W = [
  0.017614007, 0.040601429, 0.062672048, 0.083276742, 0.101930120,
  0.118194532, 0.131688638, 0.142096110, 0.149172986, 0.152753387,
  0.152753387, 0.149172986, 0.142096110, 0.131688638, 0.118194532,
  0.101930120, 0.083276742, 0.062672048, 0.040601429, 0.017614007,
];

export function integrateInfinite(f: (t: number) => number): number {
  let total = 0;
  const segments = [
    [1e-8, 1e-4], [1e-4, 1e-2], [1e-2, 0.1], [0.1, 1],
    [1, 10], [10, 100], [100, 1000], [1000, 10000],
  ];
  for (const [a, b] of segments) {
    const mid = 0.5 * (a! + b!);
    const half = 0.5 * (b! - a!);
    for (let i = 0; i < GL20_X.length; i++) {
      const t = mid + half * GL20_X[i]!;
      const val = f(t);
      if (isFinite(val)) total += GL20_W[i]! * val * half;
    }
  }
  return total;
}

export function normalizeColumns(V: Matrix): Matrix {
  return V.map(col => {
    const n = norm2(col);
    return n < 1e-14 ? col : scalarVec(1 / n, col);
  });
}

export function gramSchmidt(vecs: Matrix): Matrix {
  const result: Matrix = [];
  for (const v of vecs) {
    let u = [...v];
    for (const e of result) {
      const proj = dot(u, e);
      u = vecSub(u, scalarVec(proj, e));
    }
    const n = norm2(u);
    if (n > 1e-12) result.push(scalarVec(1 / n, u));
  }
  return result;
}

export function topEigenvectors(A: Matrix, r: number): { vectors: Matrix; values: Vec } {
  const n = A.length;
  r = Math.min(r, n);
  const vectors: Matrix = [];
  const values: Vec = [];
  let M = A.map(row => [...row]);
  for (let k = 0; k < r; k++) {
    let v: Vec = Array.from({ length: n }, (_, i) => (i === k ? 1 : Math.random() * 0.01));
    let lam = 0;
    for (let iter = 0; iter < 100; iter++) {
      const Av = matVec(M, v);
      const nAv = norm2(Av);
      if (nAv < 1e-14) break;
      const prev = [...v];
      v = scalarVec(1 / nAv, Av);
      lam = dot(v, matVec(M, v));
      if (norm2(vecSub(v, prev)) < 1e-10 && iter > 5) break;
    }
    lam = dot(v, matVec(M, v));
    vectors.push(v);
    values.push(Math.max(0, lam));
    const outer = A.map((_, i) => Array.from({ length: n }, (_, j) => lam * v[i]! * v[j]!));
    M = matSub(M, outer);
  }
  return { vectors, values };
}
