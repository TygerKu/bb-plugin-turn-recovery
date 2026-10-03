import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";

export const ERROR_CATEGORIES = [
  "active-turn-not-steerable", "bad-request", "billing", "budget-exceeded",
  "connection-failed", "context-window-exceeded", "internal", "max-output-tokens",
  "max-turns", "overloaded", "policy", "rate-limit", "sandbox", "stream-disconnected",
  "structured-output-retries", "thread-rollback-failed", "too-many-failed-attempts",
  "unauthorized", "unknown",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];
export type FailureAction = "retry" | "continue" | "ignore";

export interface CategoryPolicy {
  action: FailureAction;
  maxRetries: number | null;
  initialDelayMs: number;
  multiplier: number;
  jitterMs: number;
}

export interface CustomPolicyRule {
  id: string;
  name: string;
  category?: ErrorCategory;
  messageIncludes?: string;
  providerCode?: string;
  httpStatusCode?: number;
  policy: CategoryPolicy;
}

export type RecoveryPolicies = Record<ErrorCategory, CategoryPolicy>;

export const DEFAULT_POLICIES: RecoveryPolicies = Object.fromEntries(
  ERROR_CATEGORIES.map((category) => [
    category,
    {
      action:
        category === "connection-failed" || category === "stream-disconnected" || category === "policy"
          ? "continue"
          : category === "overloaded" || category === "rate-limit"
            ? "retry"
            : "ignore",
      maxRetries: 4,
      initialDelayMs: category === "overloaded" ? 5_000 : 1_000,
      multiplier: category === "overloaded" ? 2 : 1,
      jitterMs: 1_000,
    },
  ]),
) as RecoveryPolicies;

export const DEFAULT_CUSTOM_RULES: CustomPolicyRule[] = [
  {
    id: "default-upstream-http2-stream-failed",
    name: "Upstream HTTP/2 stream failure",
    messageIncludes: "Upstream HTTP/2 stream failed",
    policy: { action: "continue", maxRetries: 4, initialDelayMs: 1_000, multiplier: 1, jitterMs: 1_000 },
  },
  {
    id: "default-invalid-prompt",
    name: "Invalid prompt policy rejection",
    messageIncludes: "Invalid prompt:",
    policy: { action: "continue", maxRetries: 4, initialDelayMs: 1_000, multiplier: 1, jitterMs: 1_000 },
  },
  {
    id: "default-upstream-response-stream-interrupted",
    name: "Upstream response stream interrupted",
    messageIncludes: "Upstream response stream was interrupted",
    policy: { action: "continue", maxRetries: 4, initialDelayMs: 1_000, multiplier: 1, jitterMs: 1_000 },
  },
  {
    id: "default-do-request-failed",
    name: "Upstream do_request_failed",
    messageIncludes: "do_request_failed",
    policy: { action: "continue", maxRetries: 4, initialDelayMs: 1_000, multiplier: 1, jitterMs: 1_000 },
  },
  {
    id: "default-concurrency-limit-exceeded",
    name: "Concurrency limit exceeded",
    messageIncludes: "Concurrency limit exceeded for user",
    policy: { action: "retry", maxRetries: null, initialDelayMs: 5_000, multiplier: 2, jitterMs: 5_000 },
  },
 ];

export interface RecoveryDecision {
  action: FailureAction;
  sendAt?: number;
  reason: string;
}

export function decideRecovery(args: {
  failure: PluginTurnFailedEvent;
  policies: RecoveryPolicies;
  customRules?: CustomPolicyRule[];
  errorMessage?: string | null;
  now: number;
  random: number;
}): RecoveryDecision {
  const { failure } = args;
  const info = failure.errorInfo;
  const category = info?.category;
  const message = args.errorMessage ?? "";
  const custom = [...(args.customRules ?? [])]
    .sort((left, right) => {
      const conditions = (rule: CustomPolicyRule) => Number(rule.category !== undefined) + Number(rule.messageIncludes !== undefined) + Number(rule.providerCode !== undefined) + Number(rule.httpStatusCode !== undefined);
      return conditions(right) - conditions(left);
    })
    .find((rule) =>
      (rule.category === undefined || rule.category === category) &&
      (rule.messageIncludes === undefined || message.toLocaleLowerCase().includes(rule.messageIncludes.toLocaleLowerCase())) &&
      (rule.providerCode === undefined || rule.providerCode === info?.providerCode) &&
      (rule.httpStatusCode === undefined || rule.httpStatusCode === info?.httpStatusCode),
    );
  if (!custom && (!category || !ERROR_CATEGORIES.includes(category as ErrorCategory))) {
    return { action: "ignore", reason: "Unclassified provider error" };
  }
  const policy = custom?.policy ?? args.policies[category as ErrorCategory];
  const retriesAlreadyMade = failure.attemptNumber - 1;
  if (policy.maxRetries !== null && retriesAlreadyMade >= policy.maxRetries) {
    return { action: "ignore", reason: "Attempt limit reached" };
  }
  if (policy.action !== "retry") {
    return { action: policy.action, reason: custom ? `Custom policy: ${custom.name}` : `Configured action: ${policy.action}` };
  }

  let baseAt = args.now + policy.initialDelayMs * policy.multiplier ** Math.max(0, retriesAlreadyMade);
  if (category === "rate-limit" && !custom) {
    if (failure.rateLimits?.status !== "blocked" || failure.rateLimits.kind !== "subscription-window") {
      return { action: "ignore", reason: "Rate limit has no resettable subscription window" };
    }
    const windows = failure.rateLimits.windows.filter((window) => window.status === "blocked" && window.resetsAtMs !== null);
    if (windows.length === 0) return { action: "ignore", reason: "No subscription reset time reported" };
    baseAt = Math.max(baseAt, ...windows.map((window) => window.resetsAtMs as number));
  }
  const jitter = Math.floor(Math.max(0, Math.min(args.random, 0.999999)) * policy.jitterMs);
  return {
    action: "retry",
    sendAt: baseAt + jitter,
    reason: custom ? `Turn Recovery: ${custom.name}` : `Turn Recovery: ${category}`,
  };
}
