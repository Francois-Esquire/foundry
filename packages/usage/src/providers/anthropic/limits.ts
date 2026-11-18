import type {
  Options,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { type ReportedLimit, spendCap, window } from "../../limit";
import type { Reading } from "../../snapshot";
import { dateFrom, finite, record, text, within } from "../values";

export interface AnthropicDetails {
  readonly extraUsage?: {
    readonly enabled: boolean;
    readonly disabledReason?: string;
  };
}

declare module "../../snapshot" {
  interface ProviderDetails {
    readonly anthropic?: AnthropicDetails;
  }
}

export type ClaudeQuery = (params: {
  options: Options;
  prompt: AsyncIterable<SDKUserMessage>;
}) => Pick<
  Query,
  | "close"
  | "initializationResult"
  | "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"
>;

export interface ClaudeProbe {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly executable?: string;
  readonly initTimeoutMs: number;
  readonly query: ClaudeQuery;
  readonly usageTimeoutMs: number;
}

const MINOR_UNITS_BASE = 10;

const QUIET_ENV = {
  CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
  CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
} as const;

const silentPrompt = (signal: AbortSignal): AsyncIterable<SDKUserMessage> => {
  const ended = new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
    signal.addEventListener(
      "abort",
      () => resolve({ done: true, value: undefined }),
      { once: true }
    );
  });
  return { [Symbol.asyncIterator]: () => ({ next: () => ended }) };
};

export const readClaudeLimits = async (
  probe: ClaudeProbe
): Promise<Reading> => {
  const abortController = new AbortController();
  const session = probe.query({
    options: {
      abortController,
      allowedTools: [],
      cwd: probe.cwd,
      env: { ...probe.env, ...QUIET_ENV },
      mcpServers: {},
      permissionMode: "dontAsk",
      persistSession: false,
      settingSources: [],
      settings: { disableAllHooks: true },
      stderr: () => undefined,
      strictMcpConfig: true,
      tools: [],
      ...(probe.executable
        ? { pathToClaudeCodeExecutable: probe.executable }
        : {}),
    },
    prompt: silentPrompt(abortController.signal),
  });
  try {
    const init = await within(
      session.initializationResult(),
      probe.initTimeoutMs,
      `Claude Code did not start within ${probe.initTimeoutMs} ms.`
    );
    const account = record(record(init).account);
    const refused = refusal(account);
    if (refused) {
      return refused;
    }
    const usage = await within(
      session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      probe.usageTimeoutMs,
      `Claude Code did not report usage within ${probe.usageTimeoutMs} ms.`
    );
    return claudeReading(account, usage);
  } finally {
    abortController.abort();
    session.close();
  }
};

const unsupported = (why: string): Reading => ({
  limits: [],
  unsupported: why,
});

const refusal = (account: Record<string, unknown>): Reading | undefined => {
  const apiProvider = text(account.apiProvider);
  if (apiProvider && apiProvider !== "firstParty") {
    return unsupported(
      `This Claude Code login uses ${apiProvider}, which has no plan limits.`
    );
  }
  const keySource = text(account.apiKeySource);
  if (keySource && keySource !== "none") {
    return unsupported(
      `This Claude Code login uses an API key (${keySource}), which has no plan limits.`
    );
  }
  if (text(account.tokenSource) === "none" && !text(account.email)) {
    return { limits: [] };
  }
};

const windowOf = (
  build: (fields: { usedPercent: number; resetsAt?: Date }) => ReportedLimit,
  value: unknown
): ReportedLimit | undefined => {
  const bucket = record(value);
  return finite(bucket.utilization)
    ? build({
        resetsAt: dateFrom(bucket.resets_at),
        usedPercent: bucket.utilization,
      })
    : undefined;
};

const dollars = (value: unknown): number | undefined => {
  const money = record(value);
  if (
    text(money.currency) !== "USD" ||
    !finite(money.amount_minor) ||
    !finite(money.exponent)
  ) {
    return;
  }
  return money.amount_minor / MINOR_UNITS_BASE ** money.exponent;
};

const capOf = (limits: Record<string, unknown>): ReportedLimit | undefined => {
  const spend = record(limits.spend);
  const used = dollars(record(spend.used));
  const cap = dollars(record(spend.limit));
  if (spend.enabled === true && used !== undefined && cap !== undefined) {
    return spendCap({ cap, used });
  }
  const extra = record(limits.extra_usage);
  const scale =
    MINOR_UNITS_BASE **
    (finite(extra.decimal_places) ? extra.decimal_places : 2);
  if (
    extra.is_enabled === true &&
    text(extra.currency) === "USD" &&
    finite(extra.used_credits) &&
    finite(extra.monthly_limit)
  ) {
    return spendCap({
      cap: extra.monthly_limit / scale,
      used: extra.used_credits / scale,
    });
  }
};

const modelWindowsOf = (scoped: unknown): ReportedLimit[] => {
  const found = new Map<string, ReportedLimit>();
  for (const entry of (Array.isArray(scoped) ? scoped : []).map(record)) {
    const model = text(entry.display_name);
    const scopedWindow =
      model && windowOf((fields) => window.weekly({ ...fields, model }), entry);
    if (model && scopedWindow && !found.has(model)) {
      found.set(model, scopedWindow);
    }
  }
  return [...found.values()];
};

const detailsOf = (extraUsage: unknown): AnthropicDetails => {
  const extra = record(extraUsage);
  const disabledReason = text(extra.disabled_reason);
  return typeof extra.is_enabled === "boolean"
    ? {
        extraUsage: {
          enabled: extra.is_enabled,
          ...(disabledReason ? { disabledReason } : {}),
        },
      }
    : {};
};

export const claudeReading = (
  accountValue: unknown,
  usageValue: unknown
): Reading => {
  const account = record(accountValue);
  const usage = record(usageValue);
  const email = text(account.email);
  const plan = text(usage.subscription_type) ?? text(account.subscriptionType);
  const identity = email
    ? {
        identity: { email, id: email.toLowerCase(), ...(plan ? { plan } : {}) },
      }
    : {};
  if (usage.rate_limits_available === false) {
    return {
      ...identity,
      ...unsupported("This Claude login reports no plan limits."),
    };
  }
  const rateLimits = record(usage.rate_limits);
  const windows = [
    windowOf(
      (fields) => window.hourly({ ...fields, hours: 5 }),
      rateLimits.five_hour
    ),
    windowOf(window.weekly, rateLimits.seven_day),
    ...modelWindowsOf(rateLimits.model_scoped),
  ].filter((limit) => limit !== undefined);
  if (windows.length === 0) {
    throw new Error("Claude Code reported no limits for a signed-in login.");
  }
  const cap = capOf(rateLimits);
  return {
    ...identity,
    details: { anthropic: detailsOf(rateLimits.extra_usage) },
    limits: cap ? [...windows, cap] : windows,
  };
};
