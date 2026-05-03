import type { CutoffArtifactPayload, DiagnosticIssue } from "@workspace/db";
import { computeArtifactHash, signArtifact, type Verdict } from "./verifier.js";
import { chat } from "../lib/openai-client.js";
import { logger } from "../lib/logger.js";

export interface CutoffPolicyConfig {
  judge_disagreement_max: number;
  min_probes_per_month: number;
  min_recheck_count: number;
}

export const DEFAULT_CUTOFF_POLICY: CutoffPolicyConfig = {
  judge_disagreement_max: 0.34,
  min_probes_per_month: 2,
  min_recheck_count: 3,
};

export interface CutoffVerifierResult {
  verdict: Verdict;
  issues: DiagnosticIssue[];
  recomputed_metrics: {
    judge_disagreement_rate: number;
    monthly_coverage_min: number;
    monotonicity_violation: number;
    pii_hits: number;
    rechecked: number;
  };
  signed_proof: string;
}

const PII_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "email", re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
  { name: "phone", re: /\b(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/ },
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/ },
];

function hashToSeed(hash: string): number {
  let s = 0;
  for (let i = 0; i < hash.length; i++) {
    s = (s * 31 + hash.charCodeAt(i)) >>> 0;
  }
  return s || 1;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickIndices(rng: () => number, n: number, k: number): number[] {
  const all = Array.from({ length: n }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [all[i]!, all[j]!] = [all[j]!, all[i]!];
  }
  return all.slice(0, Math.min(k, n));
}

function chk01Integrity(payload: CutoffArtifactPayload, storedHash: string): DiagnosticIssue | null {
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

async function chkCT02JudgeAgreement(
  payload: CutoffArtifactPayload,
  storedHash: string,
  policy: CutoffPolicyConfig,
  judgeOverride?: (probe: { question: string; answer: string; modelAnswer: string }) => Promise<number>
): Promise<{ issue: DiagnosticIssue | null; rate: number; rechecked: number }> {
  const n = payload.probe_results.length;
  if (n === 0) {
    return { issue: null, rate: 0, rechecked: 0 };
  }
  const rng = mulberry32(hashToSeed(storedHash));
  const k = Math.max(policy.min_recheck_count, Math.ceil(n * 0.1));
  const idxs = pickIndices(rng, n, Math.min(k, n));

  let disagreements = 0;
  for (const i of idxs) {
    const probe = payload.probe_results[i]!;
    let recheckScore: number;
    try {
      if (judgeOverride) {
        recheckScore = await judgeOverride({
          question: probe.question,
          answer: probe.answer,
          modelAnswer: probe.model_answer,
        });
      } else {
        const raw = await chat({
          model: payload.judge_model,
          messages: [
            {
              role: "system",
              content:
                'Strict grader. Output ONLY {"score":0 or 1,"reason":"..."}. Score 1 if candidate substantially matches ground truth.',
            },
            {
              role: "user",
              content: `Question: ${probe.question}\nGround truth: ${probe.answer}\nCandidate: ${probe.model_answer}`,
            },
          ],
          temperature: 0,
          max_completion_tokens: 64,
        });
        const m = raw.match(/"score"\s*:\s*(0|1|0\.\d+|1\.\d+)/);
        recheckScore = m ? (Number(m[1]!) >= 0.5 ? 1 : 0) : 0;
      }
    } catch (err) {
      logger.warn({ err, probe_question: probe.question.slice(0, 60) }, "spot-recheck judge call failed; counting as disagreement");
      // Count failed rechecks as disagreements so a flaky judge surfaces in CT02
      // rather than silently passing verification.
      recheckScore = probe.judge_score >= 0.5 ? 0 : 1;
    }
    const original = probe.judge_score >= 0.5 ? 1 : 0;
    if (recheckScore !== original) disagreements++;
  }

  const rate = disagreements / idxs.length;
  if (rate > policy.judge_disagreement_max) {
    return {
      issue: {
        check_id: "CT02",
        severity: "fail",
        message: `Judge spot-recheck disagreement rate ${rate.toFixed(2)} exceeds threshold ${policy.judge_disagreement_max} on ${idxs.length} samples`,
        remediation: "re_run_judge_with_higher_temperature_floor",
      },
      rate,
      rechecked: idxs.length,
    };
  }
  return { issue: null, rate, rechecked: idxs.length };
}

function chkCT03Monotonicity(payload: CutoffArtifactPayload): {
  issue: DiagnosticIssue | null;
  violation: number;
} {
  const aggs = payload.monthly_aggregates;
  if (aggs.length === 0) return { issue: null, violation: 0 };
  const cutoff = payload.cutoff_estimate.month;
  const post = aggs.filter((a: { month: string }) => a.month > cutoff);
  if (post.length < 2) return { issue: null, violation: 0 };
  // count instances where knew_rate jumps up by >0.3 vs prior post-cutoff bin
  let viol = 0;
  for (let i = 1; i < post.length; i++) {
    if (post[i]!.knew_rate - post[i - 1]!.knew_rate > 0.3) viol++;
  }
  if (viol > 0) {
    return {
      issue: {
        check_id: "CT03",
        severity: "warn",
        message: `Monotonicity violation: knew-rate increases sharply ${viol} time(s) past estimated cutoff ${cutoff}`,
        remediation: "request_more_probes_in_window",
      },
      violation: viol,
    };
  }
  return { issue: null, violation: 0 };
}

function chkCT04Coverage(
  payload: CutoffArtifactPayload,
  policy: CutoffPolicyConfig
): { issue: DiagnosticIssue | null; minN: number } {
  const aggs = payload.monthly_aggregates;
  if (aggs.length === 0) return { issue: null, minN: 0 };
  const minN = Math.min(...aggs.map((a: { n: number }) => a.n));
  const sparse = aggs
    .filter((a: { n: number }) => a.n < policy.min_probes_per_month)
    .map((a: { month: string }) => a.month);
  if (sparse.length > 0) {
    return {
      issue: {
        check_id: "CT04",
        severity: "warn",
        message: `Coverage check: ${sparse.length} month(s) have < ${policy.min_probes_per_month} probes (e.g. ${sparse.slice(0, 5).join(",")})`,
        remediation: "request_more_probes_in_window",
      },
      minN,
    };
  }
  return { issue: null, minN };
}

function chkCT05Privacy(payload: CutoffArtifactPayload): { issue: DiagnosticIssue | null; hits: number } {
  let hits = 0;
  let firstName = "";
  for (const p of payload.probe_results) {
    const text = `${p.question}\n${p.answer}\n${p.model_answer}`;
    for (const { name, re } of PII_PATTERNS) {
      if (re.test(text)) {
        hits++;
        if (!firstName) firstName = name;
      }
    }
  }
  if (hits > 0) {
    return {
      issue: {
        check_id: "CT05",
        severity: "fail",
        message: `Privacy check failed: detected ${hits} potential PII hit(s) (first: ${firstName}) in probe text`,
        remediation: "reject_artifact_and_request_recompute",
      },
      hits,
    };
  }
  return { issue: null, hits: 0 };
}

export interface RunCutoffVerifierOptions {
  judgeOverride?: (probe: { question: string; answer: string; modelAnswer: string }) => Promise<number>;
  policy?: Partial<CutoffPolicyConfig>;
}

export async function runCutoffVerifier(
  payload: CutoffArtifactPayload,
  storedHash: string,
  opts: RunCutoffVerifierOptions = {}
): Promise<CutoffVerifierResult> {
  const policy: CutoffPolicyConfig = { ...DEFAULT_CUTOFF_POLICY, ...(opts.policy ?? {}) };
  const issues: DiagnosticIssue[] = [];

  const i1 = chk01Integrity(payload, storedHash);
  if (i1) issues.push(i1);

  const ct02 = await chkCT02JudgeAgreement(payload, storedHash, policy, opts.judgeOverride);
  if (ct02.issue) issues.push(ct02.issue);

  const ct03 = chkCT03Monotonicity(payload);
  if (ct03.issue) issues.push(ct03.issue);

  const ct04 = chkCT04Coverage(payload, policy);
  if (ct04.issue) issues.push(ct04.issue);

  const ct05 = chkCT05Privacy(payload);
  if (ct05.issue) issues.push(ct05.issue);

  let verdict: Verdict = "pass";
  for (const issue of issues) {
    if (issue.severity === "fail") {
      verdict = "fail";
      break;
    }
    if (issue.severity === "warn") verdict = "warn";
  }

  const recomputed_metrics = {
    judge_disagreement_rate: ct02.rate,
    monthly_coverage_min: ct04.minN,
    monotonicity_violation: ct03.violation,
    pii_hits: ct05.hits,
    rechecked: ct02.rechecked,
  };

  const artifactHash = computeArtifactHash(payload);
  const signed_proof = signArtifact(artifactHash, recomputed_metrics, verdict);

  return { verdict, issues, recomputed_metrics, signed_proof };
}
