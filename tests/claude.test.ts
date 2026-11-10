import { beforeEach, describe, expect, it, vi } from "vitest";

// Stand-in for the Anthropic SDK client so we can assert the request shape and exercise
// refusal / error fallbacks without network calls.
// A plain stub rather than vi.fn(): vi.fn tracks returned promises and reports a rejection
// as a test failure even when the code under test handles it.
const stub = vi.hoisted(() => ({
  calls: [] as Record<string, any>[],
  impl: (async () => null) as (req: Record<string, any>) => Promise<unknown>,
}));
const parse = (req: Record<string, any>) => {
  stub.calls.push(req);
  return stub.impl(req);
};

vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status = 500;
  }
  class AuthenticationError extends APIError {}
  class PermissionDeniedError extends APIError {}
  class RateLimitError extends APIError {}
  class Anthropic {
    static APIError = APIError;
    static AuthenticationError = AuthenticationError;
    static PermissionDeniedError = PermissionDeniedError;
    static RateLimitError = RateLimitError;
    beta = { messages: { parse } };
  }
  return { default: Anthropic };
});

vi.mock("../src/config.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/config.js")>();
  return { ...mod, config: { ...mod.config, ai: { ...mod.config.ai, provider: "anthropic", model: "claude-opus-5-5" } } };
});

const { parseSearchQuery } = await import("../src/services/ai/querySearch.js");
const Anthropic = (await import("@anthropic-ai/sdk")).default;

const intent = {
  semanticQuery: "frontend engineer",
  skills: ["React"],
  location: "Berlin",
  workMode: "hybrid",
  employmentType: null,
  experienceLevel: "senior",
  salaryMin: 90000,
};

beforeEach(() => {
  stub.calls.length = 0;
});

describe("Claude integration", () => {
  it("sends a structured-output request with refusal fallbacks enabled", async () => {
    stub.impl = async () => ({ stop_reason: "end_turn", parsed_output: intent });
    const { intent: result, source } = await parseSearchQuery("senior react jobs in Berlin, hybrid, 90k+");

    expect(source).toBe("claude");
    expect(result.skills).toEqual(["react"]);
    const req = stub.calls[0]!;
    expect(req).toMatchObject({
      model: "claude-opus-5-5",
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
    });
    expect(req.output_config.format).toBeDefined();
    expect(req.thinking).toBeUndefined();
    expect(req.messages[0].content).toContain("<query>");
  });

  it("falls back to the heuristic engine when Claude declines", async () => {
    stub.impl = async () => ({ stop_reason: "refusal", stop_details: { category: "cyber" }, parsed_output: null });
    const { intent: result, source } = await parseSearchQuery("remote python jobs");
    expect(source).toBe("heuristic");
    expect(result.workMode).toBe("remote");
  });

  it("falls back on API errors such as rate limits", async () => {
    // The mocked class takes only a message (the real one also needs status/headers).
    const RateLimit = Anthropic.RateLimitError as unknown as new (message: string) => Error;
    stub.impl = async () => {
      throw new RateLimit("slow down");
    };
    const { source } = await parseSearchQuery("remote python jobs");
    expect(source).toBe("heuristic");
  });
});
