import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { config } from "../../config.js";
import { logger } from "../../logger.js";

export type AiSource = "claude" | "heuristic";
export type Effort = "low" | "medium" | "high";

/** Server-side refusal fallbacks: on a policy decline the API re-runs the request on a fallback model. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

let client: Anthropic | null = null;

export function claudeEnabled(): boolean {
  return config.ai.provider === "anthropic";
}

export function getClaude(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: config.ai.anthropicApiKey, maxRetries: 2, timeout: 90_000 });
  }
  return client;
}

export class AiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiResponseError";
  }
}

/**
 * One structured-output call to Claude. The response is validated against `schema`
 * by the SDK (`parsed_output`), so callers get typed data or an exception.
 */
export async function claudeStructured<S extends z.ZodType>(opts: {
  system: string;
  prompt: string;
  schema: S;
  effort?: Effort;
  maxTokens?: number;
}): Promise<z.infer<S>> {
  const response = await getClaude().beta.messages.parse({
    model: config.ai.model,
    max_tokens: opts.maxTokens ?? 16000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: opts.effort ?? "medium", format: betaZodOutputFormat(opts.schema) },
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new AiResponseError(`Claude declined the request (${response.stop_details?.category ?? "unspecified"})`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new AiResponseError("Claude response was truncated (max_tokens)");
  }
  if (response.parsed_output == null) {
    throw new AiResponseError("Claude returned no parseable output");
  }
  return response.parsed_output as z.infer<S>;
}

/**
 * Runs the Claude implementation when Claude is configured and falls back to the local
 * heuristic engine when it is not, or when the call fails, so the product keeps working
 * (with lower quality) during outages or without an API key. `source` tells the UI which ran.
 */
export async function withAiFallback<T>(
  task: string,
  viaClaude: () => Promise<T>,
  viaHeuristic: () => T | Promise<T>,
): Promise<{ result: T; source: AiSource }> {
  if (!claudeEnabled()) {
    return { result: await viaHeuristic(), source: "heuristic" };
  }
  try {
    return { result: await viaClaude(), source: "claude" };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      logger.error({ task, status: err.status }, "Claude credentials rejected; check ANTHROPIC_API_KEY. Using heuristic engine.");
    } else if (err instanceof Anthropic.RateLimitError) {
      logger.warn({ task }, "Claude rate limited; using heuristic engine");
    } else if (err instanceof Anthropic.APIError) {
      logger.warn({ task, status: err.status, message: err.message }, "Claude API error; using heuristic engine");
    } else {
      logger.warn({ task, err }, "Claude call failed; using heuristic engine");
    }
    return { result: await viaHeuristic(), source: "heuristic" };
  }
}

/** Wraps untrusted user content so instructions inside it are treated as data. */
export function untrusted(tag: string, content: string): string {
  const safe = content.replaceAll(`</${tag}>`, `</ ${tag}>`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}
