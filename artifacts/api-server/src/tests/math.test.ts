import { describe, it, expect } from "vitest";
import {
  eye,
  matMul,
  matVec,
  transpose,
  solve,
  spectralRadius,
  conditionNumber,
  iMinus,
  integrateInfinite,
  norm2,
  dot,
  matInverse,
  topEigenvectors,
} from "../lib/math.js";

describe("eye", () => {
  it("creates correct 3x3 identity", () => {
    const I = eye(3);
    expect(I[0]).toEqual([1, 0, 0]);
    expect(I[1]).toEqual([0, 1, 0]);
    expect(I[2]).toEqual([0, 0, 1]);
  });
});

describe("matMul", () => {
  it("multiplies identity correctly", () => {
    const A = [[1, 2], [3, 4]];
    const I = eye(2);
    const result = matMul(A, I);
    expect(result[0]).toEqual([1, 2]);
    expect(result[1]).toEqual([3, 4]);
  });

  it("multiplies two 2x2 matrices", () => {
    const A = [[1, 2], [3, 4]];
    const B = [[5, 6], [7, 8]];
    const C = matMul(A, B);
    expect(C[0]![0]).toBeCloseTo(19);
    expect(C[0]![1]).toBeCloseTo(22);
    expect(C[1]![0]).toBeCloseTo(43);
    expect(C[1]![1]).toBeCloseTo(50);
  });
});

describe("transpose", () => {
  it("transposes a 2x3 matrix", () => {
    const A = [[1, 2, 3], [4, 5, 6]];
    const AT = transpose(A);
    expect(AT.length).toBe(3);
    expect(AT[0]).toEqual([1, 4]);
    expect(AT[1]).toEqual([2, 5]);
    expect(AT[2]).toEqual([3, 6]);
  });
});

describe("matInverse", () => {
  it("inverts 2x2 matrix", () => {
    const A = [[2, 1], [1, 3]];
    const Ainv = matInverse(A);
    const I = matMul(A, Ainv);
    expect(I[0]![0]).toBeCloseTo(1);
    expect(I[0]![1]).toBeCloseTo(0);
    expect(I[1]![0]).toBeCloseTo(0);
    expect(I[1]![1]).toBeCloseTo(1);
  });

  it("inverts 3x3 matrix", () => {
    const A = [[1, 2, 3], [0, 1, 4], [5, 6, 0]];
    const Ainv = matInverse(A);
    const I = matMul(A, Ainv);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(I[i]![j]).toBeCloseTo(i === j ? 1 : 0, 10);
      }
    }
  });
});

describe("solve", () => {
  it("solves 2x2 system", () => {
    const A = [[2, 1], [1, 3]];
    const b = [5, 10];
    const x = solve(A, b);
    expect(x[0]).toBeCloseTo(1);
    expect(x[1]).toBeCloseTo(3);
  });

  it("solves 3x3 system", () => {
    const A = [[3, 2, -1], [2, -2, 4], [-1, 0.5, -1]];
    const b = [1, -2, 0];
    const x = solve(A, b);
    const Ax = matVec(A, x);
    expect(Ax[0]).toBeCloseTo(b[0]!, 8);
    expect(Ax[1]).toBeCloseTo(b[1]!, 8);
    expect(Ax[2]).toBeCloseTo(b[2]!, 8);
  });
});

describe("spectralRadius", () => {
  it("returns 0 for zero matrix", () => {
    const rho = spectralRadius([[0, 0], [0, 0]]);
    expect(rho).toBeCloseTo(0);
  });

  it("returns correct radius for diagonal matrix", () => {
    const A = [[3, 0], [0, 1]];
    const rho = spectralRadius(A);
    expect(rho).toBeCloseTo(3, 1);
  });

  it("returns < 1 for contractive matrix", () => {
    const A = [[0.1, 0.2], [0.05, 0.1]];
    const rho = spectralRadius(A);
    expect(rho).toBeLessThan(1);
  });
});

describe("conditionNumber", () => {
  it("returns 1 for identity", () => {
    const cond = conditionNumber(eye(3));
    expect(cond).toBeCloseTo(1, 1);
  });

  it("returns large value for ill-conditioned matrix", () => {
    const A = [[1, 0], [0, 0.0001]];
    const cond = conditionNumber(A);
    expect(cond).toBeGreaterThan(100);
  });
});

describe("iMinus", () => {
  it("computes I - A correctly", () => {
    const A = [[0.5, 0.2], [0.1, 0.3]];
    const result = iMinus(A);
    expect(result[0]![0]).toBeCloseTo(0.5);
    expect(result[0]![1]).toBeCloseTo(-0.2);
    expect(result[1]![0]).toBeCloseTo(-0.1);
    expect(result[1]![1]).toBeCloseTo(0.7);
  });
});

describe("integrateInfinite", () => {
  it("integrates exp(-t) correctly (exact = 1)", () => {
    const result = integrateInfinite(t => Math.exp(-t));
    expect(result).toBeCloseTo(1.0, 2);
  });

  it("integrates exp(-t^2) on [0,inf) correctly (exact = sqrt(pi)/2)", () => {
    const result = integrateInfinite(t => Math.exp(-t * t));
    expect(result).toBeCloseTo(Math.sqrt(Math.PI) / 2, 2);
  });

  it("integrates t*exp(-t) correctly (exact = 1)", () => {
    const result = integrateInfinite(t => t * Math.exp(-t));
    expect(result).toBeCloseTo(1.0, 2);
  });
});

describe("topEigenvectors", () => {
  it("finds leading eigenvector of diagonal matrix", () => {
    const A = [[3, 0, 0], [0, 1, 0], [0, 0, 0.5]];
    const { vectors, values } = topEigenvectors(A, 1);
    expect(values[0]).toBeCloseTo(3, 0);
    expect(Math.abs(vectors[0]![0]!)).toBeCloseTo(1, 1);
  });
});
