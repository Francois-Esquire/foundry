import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { tempHome, writeJsonl } from "./helpers/machine";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("reads history at once while models.dev hangs, unpriced, and prices it once a host has loaded it", async () => {
  // A fresh module graph: the setup file's catalog is not loaded here.
  vi.resetModules();
  let answer: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })
    )
  );
  const { holdModelsDev } = await import(
    "@foundry/models/catalog/models-dev-source"
  );
  const { createAnthropic } = await import("../providers/anthropic/provider");
  const home = await tempHome();
  await writeJsonl(join(home, ".claude", "projects", "-repo", "s1.jsonl"), [
    {
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-5",
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      },
      requestId: "req_1",
      sessionId: "s1",
      timestamp: "2026-10-28T12:00:00Z",
      type: "assistant",
    },
  ]);
  const account = createAnthropic({ env: {}, home })();
  const since = new Date("2026-10-28T00:00:00Z");

  const hold = holdModelsDev();
  const before = await account.history(since);
  expect(before?.total.inputTokens).toBe(1_000_000);
  expect(before?.charge).toBeUndefined();

  answer?.(
    Response.json({
      models: { "anthropic/claude-sonnet-4-5": {} },
      providers: {
        anthropic: {
          models: { "claude-sonnet-4-5": { cost: { input: 3, output: 15 } } },
        },
      },
    })
  );
  await hold.loaded;
  hold.release();
  const after = await account.history(since);
  expect(after?.charge).toEqual({
    amount: { amount: 3, unit: "usd" },
    basis: "notional",
  });
});
