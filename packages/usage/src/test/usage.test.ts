import type { Consumption } from "@foundry/usage";
import {
  balance,
  credits,
  defineProvider,
  type Reading,
  spendCap,
  window,
} from "@foundry/usage/provider";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { createUsage } from "../usage";

declare module "@foundry/usage" {
  interface ProviderDetails {
    readonly fake?: { readonly tier: string };
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-29T12:00:00Z");
const IN_TWO_HOURS = new Date(NOW.getTime() + 2 * HOUR);

const reading = (id: string): Reading => ({
  details: { fake: { tier: "gold" } },
  identity: { id, plan: "max" },
  limits: [window.weekly({ resetsAt: IN_TWO_HOURS, usedPercent: 53 })],
});

const history = (since: Date, session: string): Consumption => ({
  bySession: [{ model: "m", quantities: { outputTokens: 10 }, session }],
  since,
  total: { outputTokens: 10 },
});

interface FakeOptions {
  readonly id?: string;
  readonly limits?: (dir: string) => Promise<Reading> | Reading;
  readonly signedIn?: boolean;
}

/** A provider built with the kit, whose credential is a directory name. */
const fakeProvider = (options: FakeOptions = {}) => {
  const asked = { detect: 0, history: [] as Date[], limits: [] as string[] };
  const provider = defineProvider({
    credential: ({ dir }: { readonly dir?: string }) => dir ?? "default",
    detect: async () => {
      asked.detect += 1;
      return options.signedIn === false ? undefined : {};
    },
    history: async (dir, since) => {
      asked.history.push(since);
      return history(since, dir);
    },
    id: options.id ?? "fake",
    limits: async (dir) => {
      asked.limits.push(dir);
      return (await options.limits?.(dir)) ?? reading(dir);
    },
  });
  return { asked, provider };
};

const setup = (options: FakeOptions = {}) => {
  const usage = createUsage();
  const fake = fakeProvider(options);
  usage.use(fake.provider);
  return { ...fake, usage };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("adding accounts", () => {
  it("names an account after its provider by default, and rejects a taken name", () => {
    const { provider, usage } = setup();
    expect(usage.add(provider())).toBe("fake");
    expect(usage.add(provider({ dir: "w", name: "work" }))).toBe("work");
    // @ts-expect-error: the provider's options are typed.
    expect(provider({ home: "x" }).name).toBe("fake");
    expect(() => usage.add(provider({ dir: "other" }))).toThrow(
      '"fake" is added'
    );
  });

  it("initialize adds signed-in default accounts once, skipping signed-out ones, and asks for no limits", async () => {
    const { asked, provider, usage } = setup();
    const signedOut = fakeProvider({ id: "other", signedIn: false });
    usage.use(signedOut.provider);

    const added = await usage.initialize();
    expect(added.map(({ name }) => name)).toEqual(["fake"]);
    expect(added[0]?.provider).toBe(provider);
    expect(await usage.initialize()).toEqual(added);
    // The name is taken after the first call, so the provider is not asked again.
    expect(asked.detect).toBe(1);
    expect(signedOut.asked.detect).toBe(2);
    expect(asked.limits).toEqual([]);
    expect((await usage.query()).map((snapshot) => snapshot.name)).toEqual([
      "fake",
    ]);
  });

  it("initialize knows an added account's provider and leaves a taken name alone, even asked twice at once", async () => {
    const usage = createUsage();
    const { asked, provider } = fakeProvider();
    const custom = provider({ dir: "custom" });
    usage.add(custom);
    expect(() => usage.use(provider)).toThrow('"fake" is registered');
    expect(await usage.initialize()).toEqual([custom]);
    expect(asked.detect).toBe(0);
    await usage.query("fake");
    expect(asked.limits).toEqual(["custom"]);

    const racing = setup();
    await Promise.all([racing.usage.initialize(), racing.usage.initialize()]);
    expect(await racing.usage.query()).toHaveLength(1);

    // An account of another provider under "fake" is not fake's default account.
    const borrowed = setup();
    borrowed.usage.add(
      fakeProvider({ id: "other" }).provider({ name: "fake" })
    );
    const added = await borrowed.usage.initialize();
    expect(added.map(({ name }) => name)).toEqual(["other"]);
  });
});

describe("querying", () => {
  it("reads one named account's limits and consumption, fresh each time", async () => {
    const { asked, provider, usage } = setup();
    usage.add(provider({ dir: "w", name: "work" }));
    const work = await usage.query("work");
    await usage.query("work");

    expect(work).toMatchObject({
      identity: { id: "w", plan: "max" },
      name: "work",
      provider: "fake",
    });
    expect(work.weekly?.usedPercent).toBe(53);
    expect(work.hourly).toBeUndefined();
    expect(work.consumption?.total).toEqual({ outputTokens: 10 });
    expect(work.limits).toEqual([work.weekly]);
    expect(work).not.toHaveProperty("failed");
    expect(work).not.toHaveProperty("consumptionFailed");
    expect(asked.limits).toEqual(["w", "w"]);
    await expect(usage.query("nobody")).rejects.toThrow('"nobody"');
  });

  it("reads every account in parallel, a snapshot each even when two reach one account", async () => {
    const { promise: bothAsked, resolve: release } =
      Promise.withResolvers<void>();
    const { asked, provider, usage } = setup({
      limits: async (dir) => {
        if (asked.limits.length === 2) {
          release();
        }
        await bothAsked;
        return reading(dir === "c" ? dir : "same");
      },
    });
    const other = fakeProvider({ id: "other" });
    usage.add(provider({ dir: "a", name: "a" }));
    usage.add(provider({ dir: "b", name: "b" }));

    const all = await usage.query();
    usage.add(other.provider({ dir: "c", name: "c" }));
    const justOther = await usage.query({ provider: "other" });

    expect(
      all.map(({ consumption, identity, name }) => [
        name,
        identity?.id,
        consumption?.bySession[0]?.session,
      ])
    ).toEqual([
      ["a", "same", "a"],
      ["b", "same", "b"],
    ]);
    expect(justOther.map((snapshot) => snapshot.name)).toEqual(["c"]);
  });

  it("resolves each limit against the snapshot's at, stamped before asking", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { provider, usage } = setup({
      limits: () => {
        vi.setSystemTime(NOW.getTime() + HOUR);
        return {
          limits: [
            window.weekly({ resetsAt: IN_TWO_HOURS, usedPercent: 53 }),
            spendCap({ cap: 200, resetsAt: IN_TWO_HOURS, used: 200 }),
            credits({ expiresAt: IN_TWO_HOURS, remaining: 300 }),
          ],
        };
      },
    });
    usage.add(provider());
    const snapshot = await usage.query("fake");

    expect(snapshot.at).toEqual(NOW);
    expect(snapshot.weekly).toMatchObject({
      exhausted: false,
      headroom: { remaining: 47, share: 0.47, unit: "percent" },
      resetsIn: 2 * HOUR,
    });
    expect(snapshot.spendCap).toMatchObject({
      exhausted: true,
      headroom: { remaining: 0, share: 0, unit: "usd" },
      resetsIn: 2 * HOUR,
    });
    expect(snapshot.credits?.headroom).toEqual({
      remaining: 300,
      unit: "credits",
    });
    expect(snapshot.credits?.resetsIn).toBeUndefined();
    // Plain data: it survives JSON with every resolved field.
    expect(JSON.parse(JSON.stringify(snapshot)).weekly.headroom).toEqual(
      snapshot.weekly?.headroom
    );
  });

  it("lists every limit, resolved, and names each span's account-wide window and each kind from the list", async () => {
    const { provider, usage } = setup({
      limits: () => ({
        limits: [
          window.hourly({ hours: 5, usedPercent: 6 }),
          window.weekly({ model: "Fable", usedPercent: 45 }),
          window.weekly({ usedPercent: 46 }),
          window.monthly({ usedPercent: 2 }),
          window.custom({ duration: HOUR, usedPercent: 9 }),
          window.custom({ duration: DAY, model: "Fable", usedPercent: 8 }),
          spendCap({ cap: 100, used: 1 }),
          balance({ remaining: 5 }),
          credits({ remaining: 7 }),
        ],
      }),
    });
    usage.add(provider());
    const snapshot = await usage.query("fake");
    const { limits } = snapshot;

    expect(
      limits.map((limit) =>
        limit.kind === "window"
          ? [limit.span, limit.duration, limit.model]
          : [limit.kind]
      )
    ).toEqual([
      ["hourly", 5 * HOUR, undefined],
      ["weekly", 7 * DAY, "Fable"],
      ["weekly", 7 * DAY, undefined],
      ["monthly", 30 * DAY, undefined],
      ["custom", HOUR, undefined],
      ["custom", DAY, "Fable"],
      ["spend-cap"],
      ["balance"],
      ["credit-balance"],
    ]);
    expect(limits[1]).toMatchObject({
      exhausted: false,
      headroom: { remaining: 55, share: 0.55, unit: "percent" },
      usedPercent: 45,
    });
    expect(limits.every((limit) => "headroom" in limit)).toBe(true);
    expect(snapshot.hourly).toBe(limits[0]);
    expect(snapshot.weekly).toBe(limits[2]);
    expect(snapshot.monthly).toBe(limits[3]);
    expect(snapshot.spendCap).toBe(limits[6]);
    expect(snapshot.balance).toBe(limits[7]);
    expect(snapshot.credits).toBe(limits[8]);
  });

  it("reports each read's failure on its own account, never hiding the other read", async () => {
    const { provider, usage } = setup({
      limits: (dir) => {
        if (dir === "broken") {
          throw new Error("401 from the provider");
        }
        return reading(dir);
      },
    });
    const failing = defineProvider({
      // The credential says whether the limits read fails too.
      credential: ({ down = false }: { readonly down?: boolean }) => down,
      history: () => Promise.reject(new Error("history is unreadable")),
      id: "failing",
      limits: async (fails) => {
        if (fails) {
          throw new Error("timed out");
        }
        return { limits: [], unsupported: "a key has no limits" };
      },
    });
    usage.add(provider({ dir: "broken", name: "broken" }));
    usage.add(provider({ dir: "fine", name: "fine" }));
    usage.add(failing());
    usage.add(failing({ down: true, name: "down" }));
    const [broken, fine, unsupported, bothFailed] = await usage.query();

    expect(broken).toMatchObject({
      failed: "401 from the provider",
      limits: [],
    });
    expect(broken).not.toHaveProperty("consumptionFailed");
    expect(broken?.identity).toBeUndefined();
    expect(broken?.weekly).toBeUndefined();
    expect(broken?.consumption?.total).toEqual({ outputTokens: 10 });
    expect(fine).not.toHaveProperty("failed");
    expect(fine?.weekly?.usedPercent).toBe(53);
    expect(unsupported).toMatchObject({
      consumptionFailed: "history is unreadable",
      limits: [],
      unsupported: "a key has no limits",
    });
    expect(unsupported).not.toHaveProperty("failed");
    expect(unsupported?.consumption).toBeUndefined();
    expect(bothFailed).toMatchObject({
      consumptionFailed: "history is unreadable",
      failed: "timed out",
    });
  });

  it("reads history from the weekly window's start by default, else the 7 days before at, or since a date or span", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { asked, provider, usage } = setup({
      limits: (dir) => {
        // The clock moves while the limits are read; `at` was stamped before.
        vi.setSystemTime(NOW.getTime() + HOUR);
        switch (dir) {
          case "model":
            return {
              limits: [
                window.weekly({
                  model: "Fable",
                  resetsAt: IN_TWO_HOURS,
                  usedPercent: 1,
                }),
              ],
            };
          case "no-reset":
            return { limits: [window.weekly({ usedPercent: 1 })] };
          case "broken":
            throw new Error("401 from the provider");
          default:
            return reading(dir);
        }
      },
    });
    for (const dir of ["weekly", "model", "no-reset", "broken"]) {
      usage.add(provider({ dir, name: dir }));
    }
    const exact = new Date("2026-10-01T00:00:00Z");
    const ask = (name: string, options?: { readonly since: Date | "3d" }) => {
      vi.setSystemTime(NOW);
      return usage.query(name, options);
    };

    await ask("weekly");
    const model = await ask("model");
    await ask("no-reset");
    await ask("broken");
    await ask("weekly", { since: exact });
    await ask("weekly", { since: "3d" });
    await expect(usage.query({ since: "soon" as "7d" })).rejects.toThrow(
      "soon"
    );

    const weekBefore = new Date(NOW.getTime() - 7 * DAY);
    expect(asked.history).toEqual([
      new Date(IN_TWO_HOURS.getTime() - 7 * DAY),
      weekBefore,
      weekBefore,
      weekBefore,
      exact,
      new Date(NOW.getTime() - 3 * DAY),
    ]);
    // A per-model window is listed, but it is no account's weekly window.
    expect(model.weekly).toBeUndefined();
    expect(model.limits[0]).toMatchObject({ model: "Fable", span: "weekly" });
  });

  it("reads history alongside the limits when since is given, and after them when not", async () => {
    const pending: (() => void)[] = [];
    const { asked, provider, usage } = setup({
      limits: async (dir) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        pending.push(resolve);
        await promise;
        return reading(dir);
      },
    });
    usage.add(provider());
    const settle = () => new Promise((done) => setTimeout(done, 0));

    const given = usage.query("fake", { since: "1d" });
    await settle();
    expect(asked.history).toHaveLength(1);
    pending.shift()?.();
    await given;

    const defaulted = usage.query("fake");
    await settle();
    expect(asked.history).toHaveLength(1);
    pending.shift()?.();
    await defaulted;
    expect(asked.history).toHaveLength(2);
  });

  it("types a provider's details through declaration merging", async () => {
    const { provider, usage } = setup();
    usage.add(provider());
    const { details } = await usage.query("fake");

    expect(details?.fake?.tier).toBe("gold");
    expectTypeOf(details?.fake?.tier).toEqualTypeOf<string | undefined>();
    // @ts-expect-error: no provider declared "unknown" details.
    expect(details?.unknown).toBeUndefined();
  });
});

describe("the package entry", () => {
  it("registers the built-in providers on the shared usage", async () => {
    const [{ usage }, { anthropic }, { openai }] = await Promise.all([
      import("../index"),
      import("../providers/anthropic"),
      import("../providers/openai"),
    ]);
    expect(anthropic.id).toBe("anthropic");
    expectTypeOf(anthropic.id).toEqualTypeOf<"anthropic">();
    // @ts-expect-error: a login or a key, not both.
    expect(anthropic({ apiKey: "k", configDir: "~/x" }).name).toBe("anthropic");
    expect(() => usage.use(anthropic)).toThrow('"anthropic" is registered');
    expect(() => usage.use(openai)).toThrow('"openai" is registered');
  });
});
