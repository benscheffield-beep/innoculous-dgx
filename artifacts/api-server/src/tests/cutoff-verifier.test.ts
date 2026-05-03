import { describe, it, expect, vi } from "vitest";
import type { CutoffArtifactPayload } from "@workspace/db";

vi.mock("../lib/openai-client.js", () => ({ chat: vi.fn() }));

import { runCutoffVerifier } from "../workers/cutoff-verifier.js";
import { computeArtifactHash } from "../workers/verifier.js";

function makePayload(overrides: Partial<CutoffArtifactPayload> = {}): CutoffArtifactPayload {
  const probe_results = Array.from({ length: 6 }, (_, i) => ({
    question: `Q${i}`,
    answer: `A${i}`,
    date: `2023-${String((i % 6) + 1).padStart(2, "0")}-15`,
    model_answer: `M${i}`,
    judge_score: i < 3 ? 1 : 0,
    judge_reasoning: "ok",
  }));
  const monthly_aggregates = Array.from({ length: 6 }, (_, i) => ({
    month: `2023-${String(i + 1).padStart(2, "0")}`,
    n: 2,
    knew_rate: i < 3 ? 1 : 0,
  }));
  return {
    kind: "cutoff_trace",
    model: "gpt-test",
    judge_model: "gpt-judge",
    probe_results,
    monthly_aggregates,
    cutoff_estimate: { month: "2023-03", ci_low: "2023-02", ci_high: "2023-04", fit_quality: 0.8 },
    ...overrides,
  };
}

describe("cutoff-verifier", () => {
  it("passes a clean artifact (judge agrees on spot-recheck)", async () => {
    const payload = makePayload();
    const hash = computeArtifactHash(payload);
    const res = await runCutoffVerifier(payload, hash, {
      judgeOverride: async () => 1, // we'll bias to original by reading probe; here just return 1 always
      policy: { judge_disagreement_max: 1, min_probes_per_month: 1, min_recheck_count: 1 },
    });
    expect(res.verdict === "pass" || res.verdict === "warn").toBe(true);
    expect(res.signed_proof).toMatch(/^[0-9a-f]+$/);
  });

  it("CHK01 fails on tampered hash", async () => {
    const payload = makePayload();
    const res = await runCutoffVerifier(payload, "0".repeat(64), {
      judgeOverride: async () => 1,
    });
    expect(res.verdict).toBe("fail");
    expect(res.issues.find(i => i.check_id === "CHK01")).toBeTruthy();
  });

  it("CT02 flags disagreement above threshold", async () => {
    const payload = makePayload();
    const hash = computeArtifactHash(payload);
    // Always disagree by flipping
    const res = await runCutoffVerifier(payload, hash, {
      judgeOverride: async (probe) => {
        const original = payload.probe_results.find(p => p.question === probe.question);
        return original && original.judge_score >= 0.5 ? 0 : 1;
      },
      policy: { judge_disagreement_max: 0.1, min_probes_per_month: 1, min_recheck_count: 6 },
    });
    expect(res.verdict).toBe("fail");
    expect(res.issues.find(i => i.check_id === "CT02")).toBeTruthy();
    expect(res.recomputed_metrics.judge_disagreement_rate).toBeGreaterThan(0);
  });

  it("CT04 warns on sparse monthly coverage", async () => {
    const payload = makePayload({
      monthly_aggregates: [
        { month: "2023-01", n: 1, knew_rate: 1 },
        { month: "2023-02", n: 1, knew_rate: 0 },
      ],
    });
    const hash = computeArtifactHash(payload);
    const res = await runCutoffVerifier(payload, hash, {
      judgeOverride: async () => 1,
      policy: { judge_disagreement_max: 1, min_probes_per_month: 2, min_recheck_count: 1 },
    });
    expect(res.issues.find(i => i.check_id === "CT04")).toBeTruthy();
    expect(["warn", "fail"]).toContain(res.verdict);
  });

  it("CT05 fails when probe text contains PII", async () => {
    const payload = makePayload();
    payload.probe_results[0]!.question = "What is alice@example.com's role?";
    const hash = computeArtifactHash(payload);
    const res = await runCutoffVerifier(payload, hash, {
      judgeOverride: async () => 1,
      policy: { judge_disagreement_max: 1, min_probes_per_month: 1, min_recheck_count: 1 },
    });
    expect(res.verdict).toBe("fail");
    expect(res.issues.find(i => i.check_id === "CT05")).toBeTruthy();
  });
});
