import { join } from "node:path";

import { defineProvider, spendCap, window } from "@foundry/usage/provider";
import { describe, expect, it, vi } from "vitest";

import { createAnthropic } from "../providers/anthropic";
import { jsonLines } from "../providers/machine";
import { createOpenAI } from "../providers/openai";
import { createUsage } from "../usage";
import { tempHome } from "./helpers/home";

const FIXED_NOW = new Date("2026-10-15T12:00:00Z");

describe("usage cloud-readiness fixes", () => {
  it("hides Account.credential and never exposes plaintext API keys", () => {
    const provider = defineProvider({
      credential: ({ secret }: { readonly secret: string }) => secret,
      id: "cloud",
      limits: async () => ({ limits: [] }),
    });
    const custom = provider({ name: "c", secret: "top-secret" });
    const anthropic = createAnthropic()({
      apiKey: "sk-ant-super-secret",
      name: "ant",
    });
    const openai = createOpenAI()({
      apiKey: "sk-openai-super-secret",
      name: "oai",
    });
    for (const account of [custom, anthropic, openai]) {
      expect("credential" in account).toBe(false);
      expect(JSON.stringify(account)).not.toContain("secret");
    }
  });

  it("validates UsageOptions upfront and injects clock, fetch, maxBillingPages, billingTimeoutMs, and async adminKey", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => createUsage({ maxBillingPages: bad })).toThrow(RangeError);
    }
    for (const bad of [0, -5, Number.NaN]) {
      expect(() => createUsage({ billingTimeoutMs: bad })).toThrow(RangeError);
    }

    const authHeaders: (string | null)[] = [];
    const seenSignals: (AbortSignal | undefined)[] = [];
    const fakeFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        authHeaders.push(new Headers(init?.headers).get("authorization"));
        const page = new URL(url).searchParams.get("page");
        return Response.json({
          data: [
            {
              results: [
                { amount: { currency: "usd", value: page ? 7.5 : 12.5 } },
              ],
            },
          ],
          has_more: !page,
          next_page: page ? null : "p2",
        });
      }
    ) as unknown as typeof globalThis.fetch;

    const usage = createUsage({
      billingTimeoutMs: 50,
      clock: () => FIXED_NOW,
      fetch: fakeFetch,
      maxBillingPages: 5,
    });
    usage.add({
      billing: {
        adminKey: async (options) => {
          seenSignals.push(options?.signal);
          return "  sk-trimmed-secret\n";
        },
        cap: 100,
        projectId: "proj-1",
      },
      name: "org-openai",
      provider: "openai",
    });

    await expect(usage.budget("org-openai")).resolves.toMatchObject({
      asOf: FIXED_NOW,
      cap: 100,
      remaining: 80,
      spent: 20,
    });
    expect(authHeaders).toEqual([
      "Bearer sk-trimmed-secret",
      "Bearer sk-trimmed-secret",
    ]);
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal);

    const capped = createUsage({
      clock: () => FIXED_NOW,
      fetch: fakeFetch,
      maxBillingPages: 1,
    });
    capped.add({
      billing: { adminKey: "sk-static", cap: 100 },
      name: "capped",
      provider: "openai",
    });
    expect((await capped.query("capped")).failed).toContain(
      "maximum page limit of 1"
    );

    usage.add({
      billing: {
        adminKey: () => new Promise<string>(() => undefined),
        cap: 100,
      },
      name: "slow-key",
      provider: "openai",
    });
    expect((await usage.query("slow-key")).failed).toBeDefined();
  });

  it("propagates AbortSignal in query(), budget(), and share()", async () => {
    const provider = defineProvider({
      credential: () => null,
      id: "abortable",
      limits: async (_cred, options) => {
        options?.signal?.throwIfAborted();
        return {
          limits: [
            spendCap({
              cap: 100,
              resetsAt: new Date("2026-11-01T00:00:00Z"),
              startsAt: new Date("2026-10-01T00:00:00Z"),
              used: 10,
            }),
            window.weekly({
              resetsAt: new Date("2026-10-20T12:00:00Z"),
              usedPercent: 20,
            }),
          ],
        };
      },
    });
    const usage = createUsage({ clock: () => FIXED_NOW });
    usage.add(provider({ name: "acct" }));

    const aborted = new AbortController();
    aborted.abort(new Error("pre-abort"));
    await expect(
      usage.query("acct", { signal: aborted.signal })
    ).rejects.toThrow("pre-abort");
    await expect(usage.query({ signal: aborted.signal })).rejects.toThrow(
      "pre-abort"
    );
    await expect(
      usage.budget("acct", { signal: aborted.signal })
    ).rejects.toThrow("pre-abort");
    await expect(
      usage.share("acct", "weekly", { signal: aborted.signal })
    ).rejects.toThrow("pre-abort");
  });

  it("handles ENOENT gracefully in jsonLines", async () => {
    const home = await tempHome();
    const items: unknown[] = [];
    for await (const entry of jsonLines(join(home, "vanished.jsonl"), [
      '"usage"',
    ])) {
      items.push(entry);
    }
    expect(items).toEqual([]);
  });
});
