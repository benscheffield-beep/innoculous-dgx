import {
  mercerHalfIntegrationBasis,
  validatePhase1,
  validatePhase2,
  validatePhase3,
  validatePhase4,
  validatePhase5,
  type PhaseResult,
  type WarburgParams,
} from "./warburg.js";
import type { Logger } from "pino";

const SELF_TEST_PARAMS: WarburgParams = {
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

const MERCER_SLOPE_TOL = 0.4;

export interface WarburgSelfTestResult {
  ok: boolean;
  mercer_slope: number;
  phases: PhaseResult[];
}

/**
 * Run all five Warburg phase validators plus the Mercer half-integration
 * slope check exactly once. These are pure-math identities that depend only
 * on the implementation, not on any per-job input, so they belong at startup
 * — not in the per-job Verifier. Returns a structured result so callers can
 * decide whether to log, abort, or both.
 */
export function runWarburgSelfTest(): WarburgSelfTestResult {
  const mercer = mercerHalfIntegrationBasis(0.5, 60, 10);
  const phases: PhaseResult[] = [
    validatePhase1(0.5, 1e10),
    validatePhase2(SELF_TEST_PARAMS),
    validatePhase3(0.5),
    validatePhase4(0.5),
    validatePhase5(mercer.slope, MERCER_SLOPE_TOL),
  ];
  const ok =
    phases.every((p) => p.pass) &&
    isFinite(mercer.slope) &&
    Math.abs(mercer.slope + 1) < MERCER_SLOPE_TOL;
  return { ok, mercer_slope: mercer.slope, phases };
}

/**
 * Convenience wrapper: run the self-test, log a single structured line, and
 * throw if the result is not ok. Intended for one-shot use at server boot.
 */
export function assertWarburgSelfTest(logger: Logger): void {
  const result = runWarburgSelfTest();
  if (!result.ok) {
    logger.error(
      {
        mercer_slope: result.mercer_slope,
        phases: result.phases.map((p) => ({
          phase: p.phase,
          pass: p.pass,
          measured: p.measured,
          expected: p.expected,
          message: p.message,
        })),
      },
      "Warburg startup self-test FAILED — refusing to start server",
    );
    throw new Error("Warburg startup self-test failed");
  }
  logger.info(
    {
      mercer_slope: result.mercer_slope,
      phases: result.phases.map((p) => p.message),
    },
    "Warburg startup self-test passed",
  );
}
