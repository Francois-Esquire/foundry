import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { afterEach, beforeEach, expect, it } from "vitest";
import { codexProvider } from "../codex";
import { silentExecutable } from "./helpers/env-dump";

const CALL = {
  prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
} as LanguageModelV4CallOptions;
const OFFLINE_PATTERN = /is offline/;

let cli: ReturnType<typeof silentExecutable>;
const saved = { ...process.env };

beforeEach(() => {
  cli = silentExecutable();
});

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in saved)) {
      delete process.env[name];
    }
  }
  cli.remove();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function provider() {
  return codexProvider({
    config: { available: true, binPath: cli.bin },
    env: { PATH: process.env.PATH ?? "" },
  });
}

/** Start a call that hangs on the silent app-server, once its process is up. */
async function hangingCall(
  model: ReturnType<ReturnType<typeof provider>["languageModel"]>,
  pids: number
): Promise<{ readonly call: Promise<unknown> }> {
  const call = Promise.resolve(model.doGenerate(CALL));
  call.catch(() => undefined);
  await until(() => cli.pids().length === pids);
  return { call };
}

it("going offline ends the call in flight and resolves only once the app-server has exited", async () => {
  const codex = provider();
  try {
    const { call } = await hangingCall(codex.languageModel("gpt-5.5"), 1);
    const [first = 0] = cli.pids();

    await codex.setOffline?.(true);

    expect(alive(first)).toBe(false);
    await expect(call).rejects.toThrow();
  } finally {
    await codex.dispose?.();
  }
}, 20_000);

it("refuses every call while offline, including on a model opened before", async () => {
  const codex = provider();
  const model = codex.languageModel("gpt-5.5");
  try {
    await codex.setOffline?.(true);
    await expect(model.doGenerate(CALL)).rejects.toThrow(OFFLINE_PATTERN);
    await expect(codex.languageModel("gpt-5.5").doStream(CALL)).rejects.toThrow(
      OFFLINE_PATTERN
    );
    expect(cli.pids()).toEqual([]);

    await codex.setOffline?.(false);
    await hangingCall(model, 1);
    expect(cli.pids()).toHaveLength(1);
  } finally {
    await codex.dispose?.();
  }
}, 20_000);

it("keeps one app-server while the environment holds, starts another when it changes, and stops both offline", async () => {
  const codex = provider();
  const model = codex.languageModel("gpt-5.5");
  try {
    await hangingCall(model, 1);
    await hangingCall(model, 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(cli.pids()).toHaveLength(1);

    process.env.MARBLES_CODEX_DRIFT = "late";
    await hangingCall(model, 2);
    const [old = 0, current = 0] = cli.pids();
    expect(alive(old)).toBe(true);

    await codex.setOffline?.(true);
    expect(alive(old)).toBe(false);
    expect(alive(current)).toBe(false);
  } finally {
    await codex.dispose?.();
  }
}, 20_000);

it("still stops an app-server superseded when its environment comes back", async () => {
  const codex = provider();
  const model = codex.languageModel("gpt-5.5");
  try {
    await hangingCall(model, 1);
    process.env.MARBLES_CODEX_DRIFT = "b";
    await hangingCall(model, 2);
    delete process.env.MARBLES_CODEX_DRIFT;
    await hangingCall(model, 3);
    const pids = cli.pids();

    await codex.setOffline?.(true);
    expect(pids.filter(alive)).toEqual([]);
  } finally {
    await codex.dispose?.();
  }
}, 20_000);
