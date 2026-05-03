import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CutoffTraceDescriptor } from "@workspace/db";

vi.mock("../lib/openai-client.js", () => ({
  chat: vi.fn(),
}));

import { chat } from "../lib/openai-client.js";
import { runCutoffEditor, __test } from "../workers/cutoff-editor.js";

const mockChat = vi.mocked(chat);

function makeProbes(count: number, startYear = 2022): CutoffTraceDescriptor["probes"] {
  const out: CutoffTraceDescriptor["probes"] = [];
  for (let i = 0; i < count; i++) {
    const year = startYear + Math.floor(i / 12);
    const month = (i % 12) + 1;
    out.push({
      question: `Q${i}`,
      answer: `A${i}`,
      date: `${year}-${String(month).padStart(2, "0")}-15`,
    });
  }
  return out;
}

describe("cutoff-editor: parseJudgeResponse", () => {
  it("parses clean JSON score=1", () => {
    const r = __test.parseJudgeResponse('{"score":1,"reason":"matches"}');
    expect(r.score).toBe(1);
    expect(r.reason).toBe("matches");
  });

  it("parses clean JSON score=0", () => {
    const r = __test.parseJudgeResponse('{"score":0,"reason":"nope"}');
    expect(r.score).toBe(0);
  });

  it("extracts JSON from chatter", () => {
    const r = __test.parseJudgeResponse('Here is my verdict: {"score":1,"reason":"ok"}');
    expect(r.score).toBe(1);
  });

  it("falls back to keyword detection on unparseable output", () => {
    const r = __test.parseJudgeResponse("That answer is correct.");
    expect(r.score).toBe(1);
  });

  it("returns 0 for completely unparseable output", () => {
    const r = __test.parseJudgeResponse("???");
    expect(r.score).toBe(0);
  });
});

describe("cutoff-editor: aggregateByMonth", () => {
  it("groups probes by YYYY-MM and computes knew_rate", () => {
    const agg = __test.aggregateByMonth([
      { question: "q", answer: "a", date: "2023-01-15", model_answer: "", judge_score: 1, judge_reasoning: "" },
      { question: "q", answer: "a", date: "2023-01-20", model_answer: "", judge_score: 0, judge_reasoning: "" },
      { question: "q", answer: "a", date: "2023-02-01", model_answer: "", judge_score: 1, judge_reasoning: "" },
    ]);
    expect(agg).toHaveLength(2);
    expect(agg[0]).toEqual({ month: "2023-01", n: 2, knew_rate: 0.5 });
    expect(agg[1]).toEqual({ month: "2023-02", n: 1, knew_rate: 1 });
  });
});

describe("cutoff-editor: fitLogisticChangepoint", () => {
  it("estimates cutoff near the boundary of knew→didn't-know transition", () => {
    const probes = [];
    for (let i = 0; i < 12; i++) {
      probes.push({
        question: "q", answer: "a",
        date: `2023-${String(i + 1).padStart(2, "0")}-15`,
        model_answer: "", judge_score: i < 6 ? 1 : 0, judge_reasoning: "",
      });
    }
    const { estimate } = __test.fitLogisticChangepoint(probes);
    expect(estimate.month >= "2023-05" && estimate.month <= "2023-08").toBe(true);
    expect(estimate.fit_quality).toBeGreaterThan(0);
    expect(estimate.ci_low <= estimate.month).toBe(true);
    expect(estimate.ci_high >= estimate.month).toBe(true);
  });

  it("returns sentinel for empty input", () => {
    const { estimate } = __test.fitLogisticChangepoint([]);
    expect(estimate.month).toBe("1970-01");
  });
});

describe("cutoff-editor: runCutoffEditor happy path", () => {
  beforeEach(() => mockChat.mockReset());

  it("produces an artifact with probe_results, monthly_aggregates, and cutoff_estimate", async () => {
    const descriptor: CutoffTraceDescriptor = {
      kind: "cutoff_trace",
      model: "gpt-test",
      judge_model: "gpt-judge",
      probes: makeProbes(8, 2023),
    };

    let call = 0;
    mockChat.mockImplementation(async () => {
      call += 1;
      // alternating: target answer, then judge JSON
      if (call % 2 === 1) return "model answer";
      const probeIdx = Math.floor((call - 1) / 2);
      const score = probeIdx < 4 ? 1 : 0;
      return `{"score":${score},"reason":"r"}`;
    });

    const { artifact } = await runCutoffEditor(descriptor);
    expect(artifact.kind).toBe("cutoff_trace");
    expect(artifact.probe_results).toHaveLength(8);
    expect(artifact.monthly_aggregates.length).toBeGreaterThan(0);
    expect(artifact.cutoff_estimate.month).toMatch(/^\d{4}-\d{2}$/);
    expect(mockChat).toHaveBeenCalledTimes(16);
  });

  it("treats target-model failures as wrong answers without crashing", async () => {
    const descriptor: CutoffTraceDescriptor = {
      kind: "cutoff_trace",
      model: "gpt-test",
      judge_model: "gpt-judge",
      probes: makeProbes(2, 2023),
    };

    mockChat
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValueOnce('{"score":0,"reason":"empty"}')
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValueOnce('{"score":0,"reason":"empty"}');

    const { artifact } = await runCutoffEditor(descriptor);
    expect(artifact.probe_results).toHaveLength(2);
    expect(artifact.probe_results.every(r => r.judge_score === 0)).toBe(true);
  });

  it("handles judge-call failures by recording score=0", async () => {
    const descriptor: CutoffTraceDescriptor = {
      kind: "cutoff_trace",
      model: "gpt-test",
      judge_model: "gpt-judge",
      probes: makeProbes(2, 2023),
    };

    mockChat
      .mockResolvedValueOnce("model answer")
      .mockRejectedValueOnce(new Error("judge down"))
      .mockResolvedValueOnce("model answer")
      .mockRejectedValueOnce(new Error("judge down"));

    const { artifact } = await runCutoffEditor(descriptor);
    expect(artifact.probe_results).toHaveLength(2);
    expect(artifact.probe_results.every(r => r.judge_score === 0)).toBe(true);
  });
});
