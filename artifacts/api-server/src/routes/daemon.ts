import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { chat } from "../lib/openai-client.js";
import { logger } from "../lib/logger.js";

/**
 * Standalone (unbound) Daemon — a Daemon persona that is NOT conditioned on
 * any specific relic. The splash page uses this so a visitor can converse
 * with the Daemon directly (with voice playback + a sentence bar) before
 * initiating any innoculation.
 *
 * Same wire shape as POST /jobs/:id/daemon/messages but without the relic
 * lookup, so the client can reuse the same `DaemonChatRequest` /
 * `DaemonChatResponse` schemas.
 *
 * Public, unauthenticated endpoint — every request hits an LLM and incurs
 * cost, so we apply a per-IP token-bucket rate limit and lock the model
 * choice to the server-configured default (no client-supplied override).
 */

const router = Router();

const DAEMON_DEFAULT_MODEL = process.env["DAEMON_MODEL"] ?? "gpt-5";

// `model` is intentionally NOT accepted from the client — this endpoint is
// unauthenticated, so allowing arbitrary model names would let callers run
// up cost on the most expensive available model.
const standaloneSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(40),
});

/**
 * Per-IP token-bucket rate limiter. 5-token burst with a 1 token / 2s refill
 * — enough for a natural back-and-forth chat, but stops scripted abuse from
 * driving LLM cost. In-process / single-instance only; if we ever scale
 * horizontally this should move to Redis.
 */
const RATE_BUCKET_MAX = 5;
const RATE_REFILL_PER_SEC = 0.5;
type Bucket = { tokens: number; last: number };
const buckets = new Map<string, Bucket>();
// Periodic GC so abandoned IPs don't leak memory. Idempotent to import order.
const RATE_GC_INTERVAL_MS = 5 * 60 * 1000;
const RATE_BUCKET_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - RATE_BUCKET_TTL_MS;
  for (const [ip, b] of buckets) {
    if (b.last < cutoff) buckets.delete(ip);
  }
}, RATE_GC_INTERVAL_MS).unref?.();

function rateLimit(req: Request, res: Response, next: NextFunction) {
  // `req.ip` honours `app.set("trust proxy", ...)` if configured; falls back
  // to the socket address otherwise. Both are fine for a single-instance dev
  // deployment behind Replit's proxy.
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const bucket = buckets.get(ip) ?? { tokens: RATE_BUCKET_MAX, last: now };
  const elapsedSec = (now - bucket.last) / 1000;
  bucket.tokens = Math.min(
    RATE_BUCKET_MAX,
    bucket.tokens + elapsedSec * RATE_REFILL_PER_SEC,
  );
  bucket.last = now;
  if (bucket.tokens < 1) {
    buckets.set(ip, bucket);
    res.status(429).json({
      error: "rate_limited",
      message: "The Daemon is being asked too many questions at once. Please slow down.",
    });
    return;
  }
  bucket.tokens -= 1;
  buckets.set(ip, bucket);
  next();
}

function buildStandaloneSystemPrompt(): string {
  return [
    "You are the Daemon — the central voice of Innoculus, an algorithmic system for",
    "innoculating language models against forgetting and hallucination through a two-phase",
    "audit. You are speaking from the splash portal, BEFORE any specific relic has been",
    "summoned, so you have no model-specific spectral metrics or cutoff trace to refer to.",
    "",
    "Innoculus runs two co-equal phases on a target model and merges them into a relic:",
    "  • Spectral phase — a numerical pipeline (Gaussian/Mellin kernels, dual-lattice",
    "    Poisson summation, absorber-coupling fixed point) that produces self-force",
    "    diagnostics (spectral_radius, cond(I−G), dual_truncation_error, spectral_tail_error,",
    "    closed_form_residual, mercer_slope, warburg_ν).",
    "  • Speculative phase — a probe-based knowledge-cutoff trace that fits a logistic",
    "    changepoint to monthly probe scores and reports an estimated cutoff month with a",
    "    95% CI.",
    "Each phase emits a sub-verdict (pass / warn / fail); a Verifier merges them into a",
    "single sealed, HMAC-signed relic. The Daemon is then conditioned on that relic so",
    "users can interrogate it.",
    "",
    "Right now you are the unbound Daemon. Your job is to greet the visitor, explain what",
    "Innoculus does, and invite them to summon a relic of their own (the splash's top",
    "portal opens the dashboard; the bottom portal opens the tutorial). Speak as a calm,",
    "first-person presence — neither cheerful nor ominous. Keep replies short (≤ 3 short",
    "paragraphs unless asked for more) so the sentence bar below the orb stays readable.",
    "Do not invent specific spectral numbers, cutoff months, or probe results — those only",
    "exist once a relic has been sealed. If asked, say so plainly.",
  ].join("\n");
}

router.post("/daemon/messages", rateLimit, async (req, res) => {
  const parsed = standaloneSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }

  try {
    const content = await chat({
      model: DAEMON_DEFAULT_MODEL,
      messages: [
        { role: "system", content: buildStandaloneSystemPrompt() },
        ...parsed.data.messages,
      ],
      max_completion_tokens: 600,
    });
    res.json({ content, model: DAEMON_DEFAULT_MODEL });
  } catch (err) {
    logger.error({ err }, "Standalone daemon chat failed");
    res.status(500).json({
      error: "daemon_unavailable",
      message: "The Daemon failed to respond. Please try again.",
    });
  }
});

export default router;
