import OpenAI from "openai";
import { logger } from "./logger.js";

const baseURL = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  if (!baseURL || !apiKey) {
    throw new Error(
      "OpenAI client unavailable: AI_INTEGRATIONS_OPENAI_BASE_URL or AI_INTEGRATIONS_OPENAI_API_KEY not set"
    );
  }
  _client = new OpenAI({ baseURL, apiKey, timeout: 60_000 });
  return _client;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_completion_tokens?: number;
}

function isGpt5OrNewer(model: string): boolean {
  return /^(gpt-5|o[0-9])/i.test(model);
}

function isTransient(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | undefined;
  if (!e) return false;
  if (e.status === 408 || e.status === 429 || (e.status ?? 0) >= 500) return true;
  if (e.code === "ETIMEDOUT" || e.code === "ECONNRESET") return true;
  return false;
}

export async function chat(opts: ChatOptions): Promise<string> {
  const client = getClient();
  const params: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_completion_tokens: opts.max_completion_tokens ?? 1024,
  };
  if (!isGpt5OrNewer(opts.model) && opts.temperature !== undefined) {
    params["temperature"] = opts.temperature;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = (await client.chat.completions.create(
        params as unknown as Parameters<typeof client.chat.completions.create>[0]
      )) as { choices: Array<{ message?: { content?: string | null } }> };
      const text = res.choices[0]?.message?.content?.trim() ?? "";
      return text;
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === 1) {
        logger.warn({ err, model: opts.model, attempt }, "openai chat call failed");
        throw err;
      }
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("openai chat call failed");
}

export function __resetClientForTests(): void {
  _client = null;
}
