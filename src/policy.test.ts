import { describe, expect, it } from "vitest";
import { DEFAULT_POLICIES, ERROR_CATEGORIES, decideRecovery } from "./policy.js";
import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";

function makeFailure(overrides: Partial<PluginTurnFailedEvent> = {}): PluginTurnFailedEvent {
  return {
    threadId: "thread-1",
    requestId: "request-current",
    turnId: "turn-1",
    errorInfo: { category: "policy", providerCode: "invalid_prompt", httpStatusCode: 400 },
    inputAccepted: false,
    rateLimits: null,
    attemptNumber: 1,
    ...overrides,
  };
}

describe("recovery policy", () => {
  it("provides a configurable policy for every provider error category", () => {
    expect(Object.keys(DEFAULT_POLICIES).sort()).toEqual([...ERROR_CATEGORIES].sort());
  });
  it("defaults connection and stream transport failures to continuation", () => {
    expect(DEFAULT_POLICIES["connection-failed"].action).toBe("continue");
    expect(DEFAULT_POLICIES["stream-disconnected"].action).toBe("continue");
  });

  it("allows policy errors to continue without a delay", () => {
    const policies = structuredClone(DEFAULT_POLICIES);
    policies.policy.action = "continue";
    expect(decideRecovery({ failure: makeFailure(), policies, now: 1_000, random: 0 })).toEqual({
      action: "continue",
      reason: "Configured action: continue",
    });
  });

  it("applies exponential backoff and bounded jitter to retry actions", () => {
    const policies = structuredClone(DEFAULT_POLICIES);
    policies.policy = { action: "retry", maxRetries: null, initialDelayMs: 500, multiplier: 2, jitterMs: 100 };
    const decision = decideRecovery({
      failure: makeFailure({ attemptNumber: 3 }),
      policies,
      now: 10_000,
      random: 0.5,
    });
    expect(decision).toEqual({ action: "retry", sendAt: 12_050, reason: "Turn Recovery: policy" });
  });

  it("caps retries while supporting unlimited attempts", () => {
    const policies = structuredClone(DEFAULT_POLICIES);
    policies.policy = { action: "retry", maxRetries: 2, initialDelayMs: 0, multiplier: 1, jitterMs: 0 };
    expect(decideRecovery({ failure: makeFailure({ attemptNumber: 2 }), policies, now: 0, random: 0 }).action).toBe("retry");
    expect(decideRecovery({ failure: makeFailure({ attemptNumber: 3 }), policies, now: 0, random: 0 })).toMatchObject({ action: "ignore", reason: "Attempt limit reached" });
    policies.policy.maxRetries = null;
    expect(decideRecovery({ failure: makeFailure({ attemptNumber: 10_000 }), policies, now: 0, random: 0 }).action).toBe("retry");
  });
  it("matches error-message rules case-insensitively", () => {
    const rule = {
      id: "http2-message",
      name: "Upstream HTTP/2 stream failed",
      messageIncludes: "Upstream HTTP/2 stream failed",
      policy: { action: "continue" as const, maxRetries: 4, initialDelayMs: 0, multiplier: 1, jitterMs: 0 },
    };
    const decision = decideRecovery({
      failure: makeFailure({ errorInfo: { category: "unknown", providerCode: null, httpStatusCode: 502 } }),
      policies: DEFAULT_POLICIES,
      customRules: [rule],
      errorMessage: "Proxy: upstream http/2 stream failed while reading response",
      now: 0,
      random: 0,
    });
    expect(decision).toMatchObject({ action: "continue", reason: `Custom policy: ${rule.name}` });
  });


  it("enables safe built-in overload and subscription-window retry policies", () => {
    expect(DEFAULT_POLICIES.overloaded.action).toBe("retry");
    expect(DEFAULT_POLICIES["rate-limit"].action).toBe("retry");
  });

  it("matches custom provider-code rules before category policy", () => {
    const rule = {
      id: "http2",
      name: "Upstream HTTP/2 stream failed",
      providerCode: "upstream_http2_stream_failed",
      policy: { action: "continue" as const, maxRetries: 4, initialDelayMs: 0, multiplier: 1, jitterMs: 0 },
    };
    const decision = decideRecovery({
      failure: makeFailure({ errorInfo: { category: "unknown", providerCode: "upstream_http2_stream_failed", httpStatusCode: 502 } }),
      policies: DEFAULT_POLICIES,
      customRules: [rule],
      now: 0,
      random: 0,
    });
    expect(decision).toMatchObject({ action: "continue", reason: `Custom policy: ${rule.name}` });
  });

  it("does not apply retry defaults to non-resettable rate limits", () => {
    const decision = decideRecovery({
      failure: makeFailure({
        errorInfo: { category: "rate-limit", providerCode: "rate_limit", httpStatusCode: 429 },
      }),
      policies: DEFAULT_POLICIES,
      now: 0,
      random: 0,
    });
    expect(decision.action).toBe("ignore");
  });



  it("ignores unclassified failures", () => {
    expect(decideRecovery({ failure: makeFailure({ errorInfo: null }), policies: DEFAULT_POLICIES, now: 0, random: 0 }).action).toBe("ignore");
  });
});
