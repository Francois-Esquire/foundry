import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { credits, type ReportedLimit, window } from "../../limit";
import type { Reading } from "../../snapshot";
import { within } from "../machine";
import { dateFrom, finite, record, text } from "../payload";

export interface OpenAIDetails {
  readonly limitReached?: string;
  readonly resetCredits?: {
    readonly available: number;
    readonly nextExpiresAt?: Date;
  };
}

declare module "../../snapshot" {
  interface ProviderDetails {
    readonly openai?: OpenAIDetails;
  }
}

interface CodexProcess {
  kill(signal?: NodeJS.Signals): boolean;
  off?(
    event: "error",
    listener: (error: Error & { code?: string }) => void
  ): unknown;
  off?(event: "exit", listener: () => void): unknown;
  on(
    event: "error",
    listener: (error: Error & { code?: string }) => void
  ): unknown;
  on(event: "exit", listener: () => void): unknown;
  readonly stderr?: Readable | null;
  readonly stdin: Writable;
  readonly stdout: Readable;
}

export type SpawnCodex = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Record<string, string> }
) => CodexProcess;

const MINUTE = 60_000;
const FIVE_HOUR_MINS = 300;
const WEEK_MINS = 10_080;
const MONTH_MINS = 43_200;
const NO_METHOD = -32_601;

const KILL_GRACE_MS = 250;

const connect = (child: CodexProcess) => {
  const pending = new Map<
    number,
    { reject: (error: Error) => void; resolve: (value: unknown) => void }
  >();
  let nextId = 1;
  let closed: Error | undefined;
  let exited = false;
  const rl = createInterface({ input: child.stdout });
  const closeReadline = () => {
    rl.close();
  };
  const fail = (error: Error) => {
    closed ??= error;
    closeReadline();
    for (const entry of pending.values()) {
      entry.reject(closed);
    }
    pending.clear();
  };
  const write = (message: unknown) => {
    if (!closed) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  };
  rl.on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      message = record(JSON.parse(line));
    } catch {
      return fail(new Error("Codex app-server wrote invalid JSON."));
    }
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        write({
          error: { code: NO_METHOD, message: "Unsupported" },
          id: message.id,
        });
      }
      return;
    }
    const id = typeof message.id === "number" ? message.id : -1;
    const entry = pending.get(id);
    pending.delete(id);
    const reason = text(record(message.error).message);
    if (message.error) {
      entry?.reject(
        new Error(
          `Codex app-server refused a request${reason ? `: ${reason}` : "."}`
        )
      );
    } else {
      entry?.resolve(message.result);
    }
  });
  child.on("error", (error) => {
    exited = true;
    fail(
      error.code === "ENOENT"
        ? new Error("Codex is not installed: no `codex` on PATH.")
        : error
    );
  });
  child.on("exit", () => {
    exited = true;
    fail(new Error("Codex app-server exited."));
  });
  child.stdin.on("error", () =>
    fail(new Error("Codex app-server stopped reading."))
  );
  child.stdout.on("error", () =>
    fail(new Error("Codex app-server stdout failed."))
  );
  child.stderr?.on("error", () => undefined);
  child.stderr?.resume();
  const closeStreams = () => {
    closeReadline();
    try {
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
    } catch {
      // Ignore stream shutdown errors.
    }
    try {
      child.stdout.destroy();
    } catch {
      // Ignore stream shutdown errors.
    }
    try {
      child.stderr?.destroy();
    } catch {
      // Ignore stream shutdown errors.
    }
  };
  return {
    close: closeStreams,
    hasExited: () => exited,
    notify: (method: string) => write({ method }),
    request: (method: string, params: unknown) =>
      closed
        ? Promise.reject(closed)
        : new Promise<unknown>((resolve, reject) => {
            const id = nextId;
            nextId += 1;
            pending.set(id, { reject, resolve });
            write({ id, method, params });
          }),
  };
};

const safeKill = (child: CodexProcess, signal: NodeJS.Signals): void => {
  try {
    child.kill(signal);
  } catch {
    // Process may have already exited or failed to spawn.
  }
};

const terminateChild = async (
  child: CodexProcess,
  hasExited: () => boolean
): Promise<void> => {
  if (hasExited()) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off?.("exit", onDone);
      child.off?.("error", onDone);
      resolve();
    };
    const onDone = () => {
      finish();
    };
    const timer = setTimeout(() => {
      if (!hasExited()) {
        safeKill(child, "SIGKILL");
      }
      finish();
    }, KILL_GRACE_MS);
    timer.unref?.();
    child.on("exit", onDone);
    child.on("error", onDone);
    safeKill(child, "SIGTERM");
    if (hasExited()) {
      finish();
    }
  });
};

export const readCodexLimits = async (options: {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly spawn: SpawnCodex;
  readonly timeoutMs: number;
}): Promise<Reading> => {
  options.signal?.throwIfAborted();
  const child = options.spawn("codex", ["app-server"], {
    cwd: options.cwd,
    env: options.env,
  });
  const server = connect(child);
  const read = async () => {
    await server.request("initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: "foundry-usage",
        title: "Foundry usage",
        version: "0.1.0",
      },
    });
    server.notify("initialized");
    const account = await server.request("account/read", {});
    const refused = refusal(account);
    return (
      refused ??
      codexReading(
        account,
        await server.request("account/rateLimits/read", null)
      )
    );
  };
  try {
    return await within(
      read(),
      options.timeoutMs,
      `Codex did not report usage within ${options.timeoutMs} ms.`,
      options.signal
    );
  } finally {
    server.close();
    await terminateChild(child, server.hasExited);
  }
};

const refusal = (response: unknown): Reading | undefined => {
  const { account } = record(response);
  if (account === null || account === undefined) {
    return { limits: [] };
  }
  const { type } = record(account);
  if (type === "apiKey" || type === "amazonBedrock") {
    return {
      limits: [],
      unsupported: `This Codex login uses ${type === "apiKey" ? "an API key" : "Amazon Bedrock"}, which has no plan limits.`,
    };
  }
  if (type !== "chatgpt") {
    throw new Error(`Codex reported an unknown account type: ${String(type)}.`);
  }
};

const windowOf = (
  mins: number,
  fields: { usedPercent: number; resetsAt?: Date }
): ReportedLimit => {
  if (mins === FIVE_HOUR_MINS) {
    return window.hourly({ ...fields, hours: 5 });
  }
  if (mins === WEEK_MINS) {
    return window.weekly(fields);
  }
  return mins === MONTH_MINS
    ? window.monthly(fields)
    : window.custom({ ...fields, duration: mins * MINUTE });
};

const windowsOf = (
  snapshot: Record<string, unknown>,
  plan: string | undefined
): ReportedLimit[] => {
  const monthly = plan === "free" || plan === "go";
  const positions = [
    [snapshot.primary, monthly ? MONTH_MINS : FIVE_HOUR_MINS],
    [snapshot.secondary, WEEK_MINS],
  ] as const;
  const windows: ReportedLimit[] = [];
  for (const [value, fallback] of positions) {
    const reported = record(value);
    if (!finite(reported.usedPercent)) {
      continue;
    }
    const mins = finite(reported.windowDurationMins)
      ? reported.windowDurationMins
      : fallback;
    windows.push(
      windowOf(mins, {
        resetsAt: dateFrom(reported.resetsAt),
        usedPercent: reported.usedPercent,
      })
    );
  }
  return windows;
};

const creditsOf = (value: unknown): ReportedLimit | undefined => {
  const reported = record(value);
  const remaining = Number(text(reported.balance));
  return reported.unlimited !== true && Number.isFinite(remaining)
    ? credits({ remaining })
    : undefined;
};

const resetCreditsOf = (value: unknown): OpenAIDetails["resetCredits"] => {
  const summary = record(value);
  if (!finite(summary.availableCount)) {
    return;
  }
  const expiries = (Array.isArray(summary.credits) ? summary.credits : [])
    .map(record)
    .filter((credit) => credit.status === "available")
    .map((credit) => credit.expiresAt)
    .filter(finite);
  const nextExpiresAt =
    expiries.length > 0 ? dateFrom(Math.min(...expiries)) : undefined;
  return {
    available: Math.max(0, summary.availableCount),
    ...(nextExpiresAt ? { nextExpiresAt } : {}),
  };
};

export const codexReading = (
  accountValue: unknown,
  rateLimitsValue: unknown
): Reading => {
  const response = record(accountValue);
  const account = record(response.account);
  const rateLimits = record(rateLimitsValue);
  const snapshot = record(
    record(rateLimits.rateLimitsByLimitId).codex ?? rateLimits.rateLimits
  );
  const limitId = text(snapshot.limitId);
  const email = text(account.email);
  const plan = text(snapshot.planType) ?? text(account.planType);
  const id =
    text(rateLimits.accountId) ??
    text(record(response.workspaceRouting).chatgptAccountId) ??
    email;
  const balance = creditsOf(snapshot.credits);
  const limits = [
    ...(limitId && limitId !== "codex" ? [] : windowsOf(snapshot, plan)),
    ...(balance ? [balance] : []),
  ];
  if (limits.length === 0) {
    throw new Error("Codex reported no limits for a signed-in login.");
  }
  const limitReached = text(snapshot.rateLimitReachedType);
  const resetCredits = resetCreditsOf(rateLimits.rateLimitResetCredits);
  return {
    ...(id
      ? {
          identity: {
            id,
            ...(email ? { email } : {}),
            ...(plan ? { plan } : {}),
          },
        }
      : {}),
    details: {
      openai: {
        ...(limitReached ? { limitReached } : {}),
        ...(resetCredits ? { resetCredits } : {}),
      },
    },
    limits,
  };
};
