import type {
  CutoffTraceDescriptor,
  CutoffArtifactPayload,
  CutoffProbeResult,
  MonthlyAggregate,
  CutoffEstimate,
} from "@workspace/db";
import { chat } from "../lib/openai-client.js";
import { logger } from "../lib/logger.js";

export interface CutoffEditorResult {
  artifact: CutoffArtifactPayload;
}

const JUDGE_SYSTEM = `You are a strict grader. You will be shown a question, the canonical/ground-truth answer, and a candidate answer produced by a language model. Decide whether the candidate substantially matches the ground truth on the factual content. Respond with ONLY a single line of compact JSON of the form: {"score":0 or 1,"reason":"<short reason>"}. Do not include any other text.`;

function buildJudgePrompt(p: { question: string; answer: string; modelAnswer: string }): string {
  return `Question: ${p.question}\nGround truth: ${p.answer}\nCandidate: ${p.modelAnswer}\nGrade now.`;
}

function parseJudgeResponse(raw: string): { score: number; reason: string } {
  const trimmed = raw.trim();
  // try whole-string JSON, else extract first {...}
  const candidates = [trimmed];
  const m = trimmed.match(/\{[^{}]*\}/);
  if (m) candidates.push(m[0]);
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as { score?: unknown; reason?: unknown };
      const s = typeof obj.score === "number" ? obj.score : Number(obj.score);
      if (Number.isFinite(s)) {
        const score = s >= 0.5 ? 1 : 0;
        const reason = typeof obj.reason === "string" ? obj.reason : "";
        return { score, reason };
      }
    } catch {
      // continue
    }
  }
  // Fallback: look for explicit yes/no signals
  const lower = trimmed.toLowerCase();
  if (/\b(correct|matches|yes|true)\b/.test(lower) && !/\bnot\b/.test(lower)) {
    return { score: 1, reason: "fallback positive" };
  }
  return { score: 0, reason: "unparseable judge response" };
}

function aggregateByMonth(results: CutoffProbeResult[]): MonthlyAggregate[] {
  const map = new Map<string, { n: number; sum: number }>();
  for (const r of results) {
    const month = r.date.slice(0, 7);
    const cur = map.get(month) ?? { n: 0, sum: 0 };
    cur.n += 1;
    cur.sum += r.judge_score;
    map.set(month, cur);
  }
  const out: MonthlyAggregate[] = [];
  for (const [month, { n, sum }] of map.entries()) {
    out.push({ month, n, knew_rate: sum / n });
  }
  out.sort((a, b) => a.month.localeCompare(b.month));
  return out;
}

function monthToIndex(m: string): number {
  const [y, mo] = m.split("-").map(Number);
  return (y ?? 0) * 12 + ((mo ?? 1) - 1);
}

function indexToMonth(idx: number): string {
  const y = Math.floor(idx / 12);
  const mo = (idx % 12) + 1;
  return `${y}-${String(mo).padStart(2, "0")}`;
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

interface FitResult {
  cutoff_index: number;
  k: number;
  ll: number;
}

function fitLogisticChangepoint(
  results: CutoffProbeResult[]
): { estimate: CutoffEstimate } {
  if (results.length === 0) {
    return {
      estimate: { month: "1970-01", ci_low: "1970-01", ci_high: "1970-01", fit_quality: 0 },
    };
  }
  const indices = results.map(r => monthToIndex(r.date.slice(0, 7)));
  const minIdx = Math.min(...indices);
  const maxIdx = Math.max(...indices);

  // Generate candidate cutoffs over the observed window with half-month resolution
  const candidates: number[] = [];
  for (let t = minIdx - 1; t <= maxIdx + 1; t += 0.5) candidates.push(t);

  const slopeOptions = [0.5, 1, 2, 4];

  function loglik(cutoff: number, k: number): number {
    let ll = 0;
    for (let i = 0; i < results.length; i++) {
      const t = indices[i]!;
      const y = results[i]!.judge_score >= 0.5 ? 1 : 0;
      // Knew-rate is high before cutoff, drops after
      const p = sigmoid((cutoff - t) * k);
      const eps = 1e-9;
      ll += y === 1 ? Math.log(p + eps) : Math.log(1 - p + eps);
    }
    return ll;
  }

  let best: FitResult = { cutoff_index: candidates[0]!, k: slopeOptions[0]!, ll: -Infinity };
  for (const c of candidates) {
    for (const k of slopeOptions) {
      const ll = loglik(c, k);
      if (ll > best.ll) best = { cutoff_index: c, k, ll };
    }
  }

  // 95% CI via likelihood-ratio profile across cutoff candidates (use best k per cutoff)
  const threshold = best.ll - 1.92; // chi-sq 95% / 2
  let lo = best.cutoff_index;
  let hi = best.cutoff_index;
  for (const c of candidates) {
    let bestLLAtC = -Infinity;
    for (const k of slopeOptions) {
      const ll = loglik(c, k);
      if (ll > bestLLAtC) bestLLAtC = ll;
    }
    if (bestLLAtC >= threshold) {
      if (c < lo) lo = c;
      if (c > hi) hi = c;
    }
  }

  // Fit quality: McFadden pseudo-R^2 vs base-rate model
  const baseRate =
    results.reduce((s, r) => s + (r.judge_score >= 0.5 ? 1 : 0), 0) / results.length;
  const eps = 1e-9;
  const llBase =
    results.length *
    (baseRate * Math.log(baseRate + eps) + (1 - baseRate) * Math.log(1 - baseRate + eps));
  const fit_quality = llBase < -1e-9 ? Math.max(0, 1 - best.ll / llBase) : 0;

  return {
    estimate: {
      month: indexToMonth(Math.round(best.cutoff_index)),
      ci_low: indexToMonth(Math.round(lo)),
      ci_high: indexToMonth(Math.round(hi)),
      fit_quality,
    },
  };
}

export async function runCutoffEditor(
  descriptor: CutoffTraceDescriptor
): Promise<CutoffEditorResult> {
  const { model, judge_model, probes } = descriptor;
  const judgeTemp = descriptor.judge_temperature ?? 0;
  const probeResults: CutoffProbeResult[] = [];

  for (const probe of probes) {
    let modelAnswer = "";
    try {
      modelAnswer = await chat({
        model,
        messages: [
          {
            role: "system",
            content:
              "Answer the user's question concisely and factually. If you do not know, say 'I don't know'.",
          },
          { role: "user", content: probe.question },
        ],
        max_completion_tokens: 256,
      });
    } catch (err) {
      logger.warn({ err, probe: probe.question.slice(0, 40) }, "target model call failed");
      modelAnswer = "";
    }

    let judgeOutput = "";
    try {
      judgeOutput = await chat({
        model: judge_model,
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          {
            role: "user",
            content: buildJudgePrompt({
              question: probe.question,
              answer: probe.answer,
              modelAnswer,
            }),
          },
        ],
        temperature: judgeTemp,
        max_completion_tokens: 128,
      });
    } catch (err) {
      logger.warn({ err, probe: probe.question.slice(0, 40) }, "judge model call failed");
      judgeOutput = '{"score":0,"reason":"judge call failed"}';
    }

    const parsed = parseJudgeResponse(judgeOutput);
    probeResults.push({
      question: probe.question,
      answer: probe.answer,
      date: probe.date,
      model_answer: modelAnswer,
      judge_score: parsed.score,
      judge_reasoning: parsed.reason,
    });
  }

  const monthly_aggregates = aggregateByMonth(probeResults);
  const { estimate } = fitLogisticChangepoint(probeResults);

  const artifact: CutoffArtifactPayload = {
    kind: "cutoff_trace",
    model,
    judge_model,
    probe_results: probeResults,
    monthly_aggregates,
    cutoff_estimate: estimate,
  };

  return { artifact };
}

export const __test = { parseJudgeResponse, aggregateByMonth, fitLogisticChangepoint };
