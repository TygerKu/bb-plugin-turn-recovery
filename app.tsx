import { useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  useBbNavigate,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { CustomRuleRecord, PolicyRecord, rpcContract } from "./server";
import { DEFAULT_POLICIES, ERROR_CATEGORIES, type CategoryPolicy, type ErrorCategory } from "./src/policy";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

type DraftPolicy = {
  action: CategoryPolicy["action"];
  maxRetries: string;
  unlimited: boolean;
  initialDelayMs: string;
  multiplier: string;
  jitterMs: string;
};

type RecoveryLog = {
  id: string;
  timestamp: number;
  threadId: string;
  requestId: string;
  category: string | null;
  providerCode: string | null;
  httpStatusCode: number | null;
  errorMessage: string | null;
  attemptNumber: number;
  matchedRule: string | null;
  action: "retry" | "continue" | "ignore";
  reason: string;
  sendAt: number | null;
  result: string;
};

function draftFrom(policy: CategoryPolicy): DraftPolicy {
  return {
    action: policy.action,
    maxRetries: policy.maxRetries === null ? "" : String(policy.maxRetries),
    unlimited: policy.maxRetries === null,
    initialDelayMs: String(policy.initialDelayMs),
    multiplier: String(policy.multiplier),
    jitterMs: String(policy.jitterMs),
  };
}

function policyFromDraft(draft: DraftPolicy): CategoryPolicy {
  const number = (value: string, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    action: draft.action,
    maxRetries: draft.unlimited ? null : Math.max(0, Math.floor(number(draft.maxRetries, 0))),
    initialDelayMs: Math.max(0, number(draft.initialDelayMs, 0)),
    multiplier: Math.max(1, number(draft.multiplier, 1)),
    jitterMs: Math.max(0, number(draft.jitterMs, 0)),
  };
}

function label(category: string): string {
  return category.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function Editor({
  record,
  rpc,
  onSaved,
  onDeleted,
}: {
  record: PolicyRecord;
  rpc: Rpc;
  onSaved: (record: PolicyRecord) => void;
  onDeleted: (category: ErrorCategory) => void;
}) {
  const [draft, setDraft] = useState(() => draftFrom(record.policy));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(draftFrom(record.policy)), [record]);

  const update = <K extends keyof DraftPolicy>(key: K, value: DraftPolicy[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await rpc.call("policy_save", {
        category: record.category,
        policy: policyFromDraft(draft),
      });
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    try {
      await rpc.call("policy_delete", { category: record.category });
      onDeleted(record.category);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-foreground">{label(record.category)}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{record.category}</p>
        </div>
        <button type="button" className="rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10" onClick={() => void remove()} disabled={saving}>Delete policy</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm"><span className="text-muted-foreground">Action</span><select className="rounded-md border border-input bg-background px-2 py-1.5" value={draft.action} onChange={(event) => update("action", (event.currentTarget as HTMLSelectElement).value as DraftPolicy["action"])}><option value="ignore">Ignore</option><option value="continue">Continue</option><option value="retry">Retry</option></select></label>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={draft.unlimited} onChange={(event) => update("unlimited", (event.currentTarget as HTMLInputElement).checked)} />Unlimited attempts</label>
        <label className="grid gap-1 text-sm"><span className="text-muted-foreground">Maximum retries</span><input className="rounded-md border border-input bg-background px-2 py-1.5 disabled:opacity-50" type="number" min="0" step="1" value={draft.maxRetries} disabled={draft.unlimited} onChange={(event) => update("maxRetries", (event.currentTarget as HTMLInputElement).value)} /></label>
        <label className="grid gap-1 text-sm"><span className="text-muted-foreground">Initial delay (ms)</span><input className="rounded-md border border-input bg-background px-2 py-1.5" type="number" min="0" value={draft.initialDelayMs} onChange={(event) => update("initialDelayMs", (event.currentTarget as HTMLInputElement).value)} /></label>
        <label className="grid gap-1 text-sm"><span className="text-muted-foreground">Backoff multiplier</span><input className="rounded-md border border-input bg-background px-2 py-1.5" type="number" min="1" step="0.1" value={draft.multiplier} onChange={(event) => update("multiplier", (event.currentTarget as HTMLInputElement).value)} /></label>
        <label className="grid gap-1 text-sm"><span className="text-muted-foreground">Random jitter (ms)</span><input className="rounded-md border border-input bg-background px-2 py-1.5" type="number" min="0" value={draft.jitterMs} onChange={(event) => update("jitterMs", (event.currentTarget as HTMLInputElement).value)} /></label>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      <div className="mt-4 flex justify-end"><button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save policy"}</button></div>
    </div>
  );
}

function DefaultRow({ category, onAdd }: { category: ErrorCategory; onAdd: (category: ErrorCategory) => void }) {
  const policy = DEFAULT_POLICIES[category];
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
      <div className="min-w-0"><div className="truncate text-sm text-foreground">{label(category)}</div><div className="text-xs text-muted-foreground">Default: {policy.action} · {policy.maxRetries === null ? "unlimited" : `${policy.maxRetries} retries`}</div></div>
      <button type="button" className="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent" onClick={() => onAdd(category)}>Add policy</button>
    </div>
  );
}

function CustomRuleEditor({
  rpc,
  existing,
  onSaved,
  onDeleted,
}: {
  rpc: Rpc;
  existing?: CustomRuleRecord;
  onSaved: (rule: CustomRuleRecord) => void;
  onDeleted?: (id: string) => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [category, setCategory] = useState<ErrorCategory | "">(existing?.category ?? "");
  const [messageIncludes, setMessageIncludes] = useState(existing?.messageIncludes ?? "");
  const [providerCode, setProviderCode] = useState(existing?.providerCode ?? "");
  const [httpStatusCode, setHttpStatusCode] = useState(existing?.httpStatusCode ? String(existing.httpStatusCode) : "");
  const [draft, setDraft] = useState(() => draftFrom(existing?.policy ?? DEFAULT_POLICIES.unknown));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim() || (!category && !messageIncludes.trim() && !providerCode.trim() && !httpStatusCode)) {
      setError("Enter a name and at least one matching condition.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await rpc.call("custom_rule_save", {
        ...(existing ? { id: existing.id } : {}),
        name: name.trim(),
        ...(category ? { category } : {}),
        ...(messageIncludes.trim() ? { messageIncludes: messageIncludes.trim() } : {}),
        ...(providerCode.trim() ? { providerCode: providerCode.trim() } : {}),
        ...(httpStatusCode ? { httpStatusCode: Number(httpStatusCode) } : {}),
        policy: policyFromDraft(draft),
      });
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!existing || !onDeleted) return;
    setSaving(true);
    try {
      await rpc.call("custom_rule_delete", { id: existing.id });
      onDeleted(existing.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "rounded-md border border-input bg-background px-2 py-1.5 text-sm";
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2"><h3 className="font-medium text-foreground">{existing ? "Custom rule" : "New custom rule"}</h3>{existing ? <button type="button" className="text-xs text-destructive" onClick={() => void remove()} disabled={saving}>Delete</button> : null}</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">Rule name<input className={inputClass} value={name} onChange={(event) => setName((event.currentTarget as HTMLInputElement).value)} /></label>
        <label className="grid gap-1 text-sm">Error category<select className={inputClass} value={category} onChange={(event) => setCategory((event.currentTarget as HTMLSelectElement).value as ErrorCategory | "")}><option value="">Any category</option>{ERROR_CATEGORIES.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></label>
        <label className="grid gap-1 text-sm">Message contains<input className={inputClass} value={messageIncludes} placeholder="e.g. Upstream HTTP/2 stream failed" onChange={(event) => setMessageIncludes((event.currentTarget as HTMLInputElement).value)} /></label>
        <label className="grid gap-1 text-sm">Provider error code<input className={inputClass} value={providerCode} placeholder="e.g. stream_error" onChange={(event) => setProviderCode((event.currentTarget as HTMLInputElement).value)} /></label>
        <label className="grid gap-1 text-sm">HTTP status code<input className={inputClass} type="number" min="100" max="599" value={httpStatusCode} placeholder="e.g. 502" onChange={(event) => setHttpStatusCode((event.currentTarget as HTMLInputElement).value)} /></label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">Action<select className={inputClass} value={draft.action} onChange={(event) => setDraft((current) => ({ ...current, action: (event.currentTarget as HTMLSelectElement).value as DraftPolicy["action"] }))}><option value="ignore">Ignore</option><option value="continue">Continue</option><option value="retry">Retry</option></select></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.unlimited} onChange={(event) => setDraft((current) => ({ ...current, unlimited: (event.currentTarget as HTMLInputElement).checked }))} />Unlimited attempts</label>
        <label className="grid gap-1 text-sm">Maximum retries<input className={inputClass} type="number" min="0" disabled={draft.unlimited} value={draft.maxRetries} onChange={(event) => setDraft((current) => ({ ...current, maxRetries: (event.currentTarget as HTMLInputElement).value }))} /></label>
        <label className="grid gap-1 text-sm">Initial delay (ms)<input className={inputClass} type="number" min="0" value={draft.initialDelayMs} onChange={(event) => setDraft((current) => ({ ...current, initialDelayMs: (event.currentTarget as HTMLInputElement).value }))} /></label>
        <label className="grid gap-1 text-sm">Backoff multiplier<input className={inputClass} type="number" min="1" step="0.1" value={draft.multiplier} onChange={(event) => setDraft((current) => ({ ...current, multiplier: (event.currentTarget as HTMLInputElement).value }))} /></label>
        <label className="grid gap-1 text-sm">Random jitter (ms)<input className={inputClass} type="number" min="0" value={draft.jitterMs} onChange={(event) => setDraft((current) => ({ ...current, jitterMs: (event.currentTarget as HTMLInputElement).value }))} /></label>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex justify-end"><button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save custom rule"}</button></div>
    </div>
  );
}

function RecoveryLogView({ subPath: _subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [logs, setLogs] = useState<RecoveryLog[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    try {
      const result = await rpc.call("policy_list", null);
      setEnabled(result.showLogs);
      setLogs(result.logs);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const toggleLogging = async (showLogs: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const result = await rpc.call("logs_visibility_save", { showLogs });
      setEnabled(result.showLogs);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);
  useRealtime("policies-changed", () => void load());

  const deleteLog = async (id: string) => {
    setBusyId(id);
    try {
      await rpc.call("log_delete", { id });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };
  const clearLogs = async () => {
    setBusyId("all");
    try {
      await rpc.call("logs_clear", null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };


  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col space-y-4 overflow-hidden p-6">
      <header className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold text-foreground">Recovery log</h2><p className="mt-1 text-sm text-muted-foreground">The latest 200 recorded recovery decisions.</p></div><button type="button" className="rounded-md border border-destructive/50 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50" disabled={!enabled || busyId !== null || logs.length === 0} onClick={() => void clearLogs()}>Clear all logs</button></header>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/20 p-4"><div><div className="text-sm font-medium">Log recording</div><div className="text-xs text-muted-foreground">{enabled ? "Recording failures and recovery decisions." : "Recording is off; turn it on to capture future failures."}</div></div><label className="flex shrink-0 items-center gap-2 text-sm"><input type="checkbox" checked={enabled} disabled={loading} onChange={(event) => void toggleLogging((event.currentTarget as HTMLInputElement).checked)} /><span>{enabled ? "On" : "Off"}</span></label></div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading log…</p> : null}
      {!loading && enabled && logs.length === 0 ? <p className="text-sm text-muted-foreground">No recovery decisions recorded yet.</p> : null}
      {!loading && !enabled ? <p className="text-sm text-muted-foreground">Log recording is turned off.</p> : null}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain">
        {enabled ? logs.map((entry) => (
          <article key={entry.id} className="space-y-2 rounded-lg border border-border bg-card p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2"><strong>{entry.action.toUpperCase()} · {entry.category ?? "Unclassified"}</strong><time className="text-xs text-muted-foreground">{new Date(entry.timestamp).toLocaleString()}</time></div>
            <div className="text-xs text-muted-foreground">Thread: <code>{entry.threadId}</code> · Request: <code>{entry.requestId}</code> · Attempt: {entry.attemptNumber}</div>
            <p className="break-words rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-700 dark:text-red-300"><span className="font-semibold">Error:</span> {entry.errorMessage ?? "No error message found in retained thread events."}</p>
            <div>Decision: {entry.reason}{entry.matchedRule ? ` (rule: ${entry.matchedRule})` : ""}</div>
            <div className="flex items-center justify-between gap-3"><div className="text-muted-foreground">Result: {entry.result}{entry.sendAt ? ` · scheduled ${new Date(entry.sendAt).toLocaleString()}` : ""}</div><button type="button" className="rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50" disabled={busyId !== null} onClick={() => void deleteLog(entry.id)}>{busyId === entry.id ? "Deleting…" : "Delete"}</button></div>
            {entry.providerCode || entry.httpStatusCode ? <div className="text-xs text-muted-foreground">{entry.providerCode ? `Provider code: ${entry.providerCode}` : ""}{entry.providerCode && entry.httpStatusCode ? " · " : ""}{entry.httpStatusCode ? `HTTP ${entry.httpStatusCode}` : ""}</div> : null}
          </article>
        )) : null}
      </div>
    </div>
  );
}

function RecoverySettings() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [records, setRecords] = useState<PolicyRecord[]>([]);
  const [customRules, setCustomRules] = useState<CustomRuleRecord[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [available, setAvailable] = useState<ErrorCategory[]>([]);
  const [selected, setSelected] = useState<ErrorCategory | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const result = await rpc.call("policy_list", null);
      setRecords(result.policies);
      setCustomRules(result.customRules);
      setShowLogs(result.showLogs);
      setAvailable(result.availableCategories);
      setSelected((current) => current || result.availableCategories[0] || "");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);
  useRealtime("policies-changed", () => void load());
  const recordMap = useMemo(() => new Map(records.map((record) => [record.category, record])), [records]);

  const add = async (category: ErrorCategory) => {
    try {
      const saved = await rpc.call("policy_save", { category, policy: DEFAULT_POLICIES[category] });
      setRecords((current) => [...current.filter((item) => item.category !== category), saved]);
      setAvailable((current) => current.filter((item) => item !== category));
      setSelected("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const saved = (record: PolicyRecord) => setRecords((current) => [...current.filter((item) => item.category !== record.category), record]);
  const deleted = (category: ErrorCategory) => {
    setRecords((current) => current.filter((item) => item.category !== category));
    setAvailable((current) => [...current, category].sort());
  };
  const customSaved = (rule: CustomRuleRecord) => setCustomRules((current) => [...current.filter((item) => item.id !== rule.id), rule]);
  const customDeleted = (id: string) => setCustomRules((current) => current.filter((item) => item.id !== id));
  const toggleLogs = async (enabled: boolean) => {
    try {
      const result = await rpc.call("logs_visibility_save", { showLogs: enabled });
      setShowLogs(result.showLogs);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading policies…</div>;
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div><h2 className="text-lg font-semibold text-foreground">Turn Recovery policies</h2><p className="mt-1 text-sm text-muted-foreground">Customize recovery for each newly failed turn. Continue retries the failed turn by reference without sending an extra message.</p></div>
      <div className="rounded-lg border border-border bg-muted/20 p-4">
        <div className="mb-3 font-medium text-foreground">Add a policy</div>
        <div className="flex flex-col gap-2 sm:flex-row"><select className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm" value={selected} onChange={(event) => setSelected((event.currentTarget as HTMLSelectElement).value as ErrorCategory | "")}><option value="">Select an error category…</option>{available.map((category) => <option key={category} value={category}>{label(category)}</option>)}</select><button type="button" className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={!selected} onClick={() => selected && void add(selected)}>Add policy</button></div>
        <p className="mt-2 text-xs text-muted-foreground">Deleting a policy restores that category&apos;s built-in default.</p>
      </div>
      <section className="space-y-3"><div><h3 className="text-base font-semibold text-foreground">Custom error rules</h3><p className="mt-1 text-xs text-muted-foreground">Match one or more of the provider message substring, error category, provider code, or HTTP status. Every specified condition must match.</p></div>{customRules.map((rule) => <CustomRuleEditor key={rule.id} rpc={rpc} existing={rule} onSaved={customSaved} onDeleted={customDeleted} />)}<CustomRuleEditor key="new-custom-rule" rpc={rpc} onSaved={customSaved} /></section>
      <section className="rounded-lg border border-border bg-muted/20 p-4"><div className="flex items-center justify-between gap-3"><label className="flex items-center gap-3"><input type="checkbox" checked={showLogs} onChange={(event) => void toggleLogs((event.currentTarget as HTMLInputElement).checked)} /><span>Show recovery log</span></label><button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent" onClick={() => navigate.toPluginPanel("log")}>Open log page</button></div><p className="mt-1 text-xs text-muted-foreground">Enable recording of failures, original error text, selected action, and outcome. The latest 200 entries are retained.</p></section>
      {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
      <section className="space-y-3"><h3 className="text-base font-semibold text-foreground">Built-in error categories</h3>{ERROR_CATEGORIES.map((category) => { const record = recordMap.get(category); return record ? <Editor key={category} record={record} rpc={rpc} onSaved={saved} onDeleted={deleted} /> : <DefaultRow key={category} category={category} onAdd={(value) => void add(value)} />; })}</section>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "recovery-policies", component: RecoverySettings });
  app.slots.navPanel({
    id: "recovery-log",
    path: "log",
    title: "Recovery Log",
    icon: "Clock",
    component: RecoveryLogView,
  });
});
