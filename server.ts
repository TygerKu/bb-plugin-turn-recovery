import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi, type PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_CUSTOM_RULES,
  DEFAULT_POLICIES,
  ERROR_CATEGORIES,
  decideRecovery,
  type CategoryPolicy,
  type CustomPolicyRule,
  type ErrorCategory,
  type RecoveryPolicies,
} from "./src/policy.js";

const errorCategorySchema = z.enum(ERROR_CATEGORIES);
const categoryPolicySchema = z.object({
  action: z.enum(["retry", "continue", "ignore"]),
  maxRetries: z.union([z.number().int().nonnegative(), z.null()]),
  initialDelayMs: z.number().finite().nonnegative(),
  multiplier: z.number().finite().min(1),
  jitterMs: z.number().finite().nonnegative(),
});
const policyRecordSchema = z.object({ category: errorCategorySchema, policy: categoryPolicySchema });
const customRuleBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  category: errorCategorySchema.optional(),
  messageIncludes: z.string().trim().min(1).max(500).optional(),
  providerCode: z.string().trim().min(1).max(200).optional(),
  httpStatusCode: z.number().int().min(100).max(599).optional(),
  policy: categoryPolicySchema,
});
const customRuleSchema = customRuleBaseSchema.refine(
  (rule) => rule.category || rule.messageIncludes || rule.providerCode || rule.httpStatusCode,
  { message: "At least one matching condition is required" },
 );
const newCustomRuleSchema = customRuleBaseSchema.omit({ id: true }).extend({ id: z.string().optional() }).refine(
  (rule) => rule.category || rule.messageIncludes || rule.providerCode || rule.httpStatusCode,
  { message: "At least one matching condition is required" },
 );

export const rpcContract = defineRpcContract({
  policy_list: {
    input: z.null(),
    output: z.object({
      policies: z.array(policyRecordSchema),
      availableCategories: z.array(errorCategorySchema),
      customRules: z.array(customRuleSchema),
      showLogs: z.boolean(),
      logs: z.array(z.object({
        id: z.string(),
        timestamp: z.number(),
        threadId: z.string(),
        requestId: z.string(),
        category: z.string().nullable(),
        providerCode: z.string().nullable(),
        httpStatusCode: z.number().nullable(),
        attemptNumber: z.number(),
        errorMessage: z.string().nullable(),
        matchedRule: z.string().nullable(),
        action: z.enum(["retry", "continue", "ignore"]),
        reason: z.string(),
        sendAt: z.number().nullable(),
        result: z.string(),
      })),
    }),
  },
  policy_save: { input: policyRecordSchema, output: policyRecordSchema },
  policy_delete: { input: z.object({ category: errorCategorySchema }), output: z.object({ deleted: z.boolean() }) },
  custom_rule_save: { input: newCustomRuleSchema, output: customRuleSchema },
  custom_rule_delete: { input: z.object({ id: z.string().min(1) }), output: z.object({ deleted: z.boolean() }) },
  logs_visibility_save: { input: z.object({ showLogs: z.boolean() }), output: z.object({ showLogs: z.boolean() }) },
  log_delete: { input: z.object({ id: z.string().min(1) }), output: z.object({ deleted: z.boolean() }) },
  logs_clear: { input: z.null(), output: z.object({ deleted: z.number().int().nonnegative() }) },
});

export type PolicyRecord = z.infer<typeof policyRecordSchema>;
export type CustomRuleRecord = z.infer<typeof customRuleSchema>;
type StoredOverrides = Partial<Record<ErrorCategory, CategoryPolicy>>;
type RecoveryLog = {
  id: string;
  timestamp: number;
  threadId: string;
  requestId: string;
  category: string | null;
  attemptNumber: number;
  providerCode: string | null;
  httpStatusCode: number | null;
  errorMessage: string | null;
  matchedRule: string | null;
  action: "retry" | "continue" | "ignore";
  reason: string;
  sendAt: number | null;
  result: string;
};
const MAX_LOG_ENTRIES = 200;

function effectivePolicies(overrides: StoredOverrides): RecoveryPolicies {
  const policies = structuredClone(DEFAULT_POLICIES);
  for (const category of ERROR_CATEGORIES) {
    const override = overrides[category];
    if (override !== undefined) policies[category] = override;
  }
  return policies;
}

function recordsFrom(overrides: StoredOverrides): PolicyRecord[] {
  return ERROR_CATEGORIES.flatMap((category) => {
    const policy = overrides[category];
    return policy === undefined ? [] : [{ category, policy }];
  });
}

async function errorMessageForFailure(bb: BbPluginApi, failure: Pick<PluginTurnFailedEvent, "threadId" | "requestId">): Promise<string | null> {
  try {
    const collected: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>> = [];
    let beforeSeq: string | undefined;
    let foundRequest = false;
    for (let page = 0; page < 25; page += 1) {
      const events = await bb.sdk.threads.events.list({
        threadId: failure.threadId,
        types: ["client/turn/requested", "client/turn/rejected", "provider/error", "system/error"],
        order: "desc",
        limit: "100",
        ...(beforeSeq ? { beforeSeq } : {}),
      });
      if (events.length === 0) break;
      collected.push(...events);
      foundRequest ||= events.some((row) => row.type === "client/turn/requested" && row.data.requestId === failure.requestId);
      if (foundRequest) break;
      beforeSeq = String(Math.min(...events.map((row) => row.seq)));
    }
    const request = collected.find((row) => row.type === "client/turn/requested" && row.data.requestId === failure.requestId);
    if (!request) {
      const rejection = collected.find((row) => row.type === "client/turn/rejected" && row.data.requestId === failure.requestId);
      return rejection?.type === "client/turn/rejected" ? rejection.data.message : null;
    }
    const rejected = collected.find((row) => row.type === "client/turn/rejected" && row.data.requestId === failure.requestId);
    if (rejected?.type === "client/turn/rejected") return rejected.data.message;
    const followingRequestSequence = collected
      .filter((row) => row.type === "client/turn/requested" && row.seq > request.seq)
      .reduce<number | null>((earliest, row) => earliest === null || row.seq < earliest ? row.seq : earliest, null);
    const errors = collected
      .filter((row) => (row.type === "provider/error" || row.type === "system/error") && row.seq > request.seq && (followingRequestSequence === null || row.seq < followingRequestSequence))
      .sort((left, right) => right.seq - left.seq);
    const latest = errors[0];
    if (latest?.type === "provider/error") return latest.data.detail ?? latest.data.message;
    if (latest?.type === "system/error") return latest.data.detail ?? latest.data.message;
    return null;
  } catch (error) {
    bb.log.warn(`Could not read provider error text for ${failure.requestId}: ${String(error)}`);
    return null;
  }
}

export default async function plugin(bb: BbPluginApi) {
  let overrides = (await bb.storage.kv.get<StoredOverrides>("policy-overrides")) ?? {};
  const savedCustomRules = await bb.storage.kv.get<CustomRuleRecord[]>("custom-rules");
  let customRules = (await bb.storage.kv.get<CustomRuleRecord[]>("custom-rules")) ?? [];
  let defaultsSeeded = await bb.storage.kv.get<boolean>("custom-rules-defaults-seeded");
  if (!defaultsSeeded) {
    customRules = [
      ...DEFAULT_CUSTOM_RULES.map((rule) => customRules.find((saved) => saved.id === rule.id) ?? rule),
      ...customRules.filter((saved) => !DEFAULT_CUSTOM_RULES.some((rule) => rule.id === saved.id)),
    ];
    defaultsSeeded = true;
    await bb.storage.kv.set("custom-rules-defaults-seeded", true);
    await bb.storage.kv.set("custom-rules", customRules);
  } else {
    const newDefaults = DEFAULT_CUSTOM_RULES.filter((rule) => !customRules.some((saved) => saved.id === rule.id));
    if (newDefaults.length > 0) {
      customRules = [...customRules, ...newDefaults];
      await bb.storage.kv.set("custom-rules", customRules);
    }
  }
  let logsEnabled = (await bb.storage.kv.get<boolean>("logs-enabled")) ?? false;
  let recoveryLogs = (await bb.storage.kv.get<RecoveryLog[]>("recovery-logs")) ?? [];
  let policies = effectivePolicies(overrides);

  async function publish(): Promise<void> {
    policies = effectivePolicies(overrides);
    await bb.storage.kv.set("policy-overrides", overrides);
    await bb.storage.kv.set("custom-rules", customRules);
    bb.realtime.publish("policies-changed", { count: recordsFrom(overrides).length + customRules.length });
  }

  bb.rpc.register(rpcContract, {
    policy_list: async () => ({
      policies: recordsFrom(overrides),
      availableCategories: ERROR_CATEGORIES.filter((category) => overrides[category] === undefined),
      customRules,
      showLogs: logsEnabled,
      logs: logsEnabled ? recoveryLogs : [],
    }),
    policy_save: async ({ category, policy }) => {
      overrides = { ...overrides, [category]: policy };
      await publish();
      return { category, policy };
    },
    policy_delete: async ({ category }) => {
      const existed = overrides[category] !== undefined;
      const next = { ...overrides };
      delete next[category];
      overrides = next;
      await publish();
      return { deleted: existed };
    },
    custom_rule_save: async (rule) => {
      const saved: CustomRuleRecord = { ...rule, id: rule.id ?? randomUUID() };
      customRules = [...customRules.filter((item) => item.id !== saved.id), saved];
      await publish();
      return saved;
    },
    custom_rule_delete: async ({ id }) => {
      const before = customRules.length;
      customRules = customRules.filter((item) => item.id !== id);
      await publish();
      return { deleted: customRules.length < before };
    },
    logs_visibility_save: async ({ showLogs }) => {
      logsEnabled = showLogs;
      await bb.storage.kv.set("logs-enabled", logsEnabled);
      bb.realtime.publish("policies-changed", { count: recordsFrom(overrides).length + customRules.length });
      return { showLogs: logsEnabled };
    },
    log_delete: async ({ id }) => {
      const before = recoveryLogs.length;
      recoveryLogs = recoveryLogs.filter((entry) => entry.id !== id);
      await bb.storage.kv.set("recovery-logs", recoveryLogs);
      bb.realtime.publish("policies-changed", { count: recordsFrom(overrides).length + customRules.length });
      return { deleted: before - recoveryLogs.length === 1 };
    },
    logs_clear: async () => {
      const deleted = recoveryLogs.length;
      recoveryLogs = [];
      await bb.storage.kv.set("recovery-logs", recoveryLogs);
      bb.realtime.publish("policies-changed", { count: recordsFrom(overrides).length + customRules.length });
      return { deleted };
    },
  });

  async function recordFailure(event: PluginTurnFailedEvent, errorMessage: string | null, decision: ReturnType<typeof decideRecovery>, matchedRule: string | null, result: string): Promise<void> {
    const entry: RecoveryLog = {
      id: randomUUID(),
      timestamp: Date.now(),
      threadId: event.threadId,
      requestId: event.requestId,
      category: event.errorInfo?.category ?? null,
      attemptNumber: event.attemptNumber,
      providerCode: event.errorInfo?.providerCode ?? null,
      httpStatusCode: event.errorInfo?.httpStatusCode ?? null,
      errorMessage,
      matchedRule,
      action: decision.action,
      reason: decision.reason,
      sendAt: decision.sendAt ?? null,
      result,
    };
    recoveryLogs = [entry, ...recoveryLogs].slice(0, MAX_LOG_ENTRIES);
    await bb.storage.kv.set("recovery-logs", recoveryLogs);
    bb.realtime.publish("policies-changed", { count: recordsFrom(overrides).length + customRules.length });
  }

  bb.events.on("turn.failed", async (event: PluginTurnFailedEvent) => {
    const errorMessage = await errorMessageForFailure(bb, event);
    const decision = decideRecovery({ failure: event, policies, customRules, errorMessage, now: Date.now(), random: Math.random() });
    const matchedRule = [...customRules]
      .sort((left, right) => {
        const count = (rule: CustomRuleRecord) => Number(rule.category !== undefined) + Number(rule.messageIncludes !== undefined) + Number(rule.providerCode !== undefined) + Number(rule.httpStatusCode !== undefined);
        return count(right) - count(left);
      })
      .find((rule) =>
        (rule.category === undefined || rule.category === event.errorInfo?.category) &&
        (rule.messageIncludes === undefined || (errorMessage ?? "").toLocaleLowerCase().includes(rule.messageIncludes.toLocaleLowerCase())) &&
        (rule.providerCode === undefined || rule.providerCode === event.errorInfo?.providerCode) &&
        (rule.httpStatusCode === undefined || rule.httpStatusCode === event.errorInfo?.httpStatusCode),
      )?.name ?? null;
    if (decision.action === "ignore") {
      bb.log.info(`Ignored failed turn ${event.requestId}: ${decision.reason}`);
      await recordFailure(event, errorMessage, decision, matchedRule, "No action taken");
      return;
    }
    try {
      await bb.sdk.threads.retry({
        threadId: event.threadId,
        turnRequestId: event.requestId,
        ...(decision.action === "retry" ? { sendAt: decision.sendAt } : {}),
        reason: decision.reason,
      });
      await recordFailure(event, errorMessage, decision, matchedRule, "Recovery queued");
    } catch (error) {
      await recordFailure(event, errorMessage, decision, matchedRule, `Recovery failed: ${String(error)}`);
      throw error;
    }
  });

  bb.cli.register({
    name: "turn-recovery",
    summary: "Inspect Turn Recovery error policies",
    commands: [{ name: "policies", summary: "List effective error policies", usage: "bb turn-recovery policies [--json]" }],
    async run(argv) {
      if (argv.some((arg) => arg === "--help" || arg === "-h")) return { exitCode: 0, stdout: "Usage: bb turn-recovery policies [--json]\n" };
      const args = argv.filter((arg) => arg !== "--json");
      if (args.length > 1 || (args.length === 1 && args[0] !== "policies")) return { exitCode: 2, stderr: "Usage: bb turn-recovery policies [--json]\n" };
      const json = argv.includes("--json");
      const entries = Object.fromEntries(ERROR_CATEGORIES.map((category) => [category, policies[category]]));
      return {
        exitCode: 0,
        stdout: json
          ? JSON.stringify({ categories: entries, customRules }, null, 2)
          : ERROR_CATEGORIES.map((category) => `${category}: ${JSON.stringify(policies[category])}`).join("\n") + `\nCustom rules: ${customRules.length}\n`,
      };
    },
  });
}
