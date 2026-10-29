import type { Consumption } from "@foundry/usage";
import {
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
    const { asked, usage } = setup();
    const signedOut = fakeProvider({ id: "other", signedIn: false });
    usage.use(signedOut.provider);

    expect(await usage.initialize()).toEqual(["fake"]);
    expect(await usage.initialize()).toEqual(["fake"]);
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
    usage.add(provider({ dir: "custom" }));
    expect(() => usage.use(provider)).toThrow('"fake" is registered');
    expect(await usage.initialize()).toEqual(["fake"]);
    expect(asked.detect).toBe(0);
    await usage.query("fake");
    expect(asked.limits).toEqual(["custom"]);

    const racing = setup();
    await Promise.all([racing.usage.initialize(), racing.usage.initialize()]);
    expect(await racing.usage.query()).toHaveLength(1);
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

  it("names windows by span and lists per-model windows on the account-wide one", async () => {
    const { provider, usage } = setup({
      limits: () => ({
        limits: [
          window.hourly({ hours: 5, usedPercent: 6 }),
          window.weekly({ usedPercent: 46 }),
          window.weekly({ model: "Fable", usedPercent: 45 }),
          window.monthly({ usedPercent: 2 }),
          window.custom({ duration: HOUR, usedPercent: 9 }),
        ],
      }),
    });
    usage.add(provider());
    const snapshot = await usage.query("fake");

    expect(snapshot.hourly).toMatchObject({
      duration: 5 * HOUR,
      usedPercent: 6,
    });
    expect(snapshot.weekly?.usedPercent).toBe(46);
    expect(snapshot.weekly?.models?.fable).toMatchObject({
      model: "Fable",
      span: "weekly",
      usedPercent: 45,
    });
    expect(snapshot.monthly?.duration).toBe(30 * DAY);
    expect(snapshot.windows.map((found) => [found.span, found.model])).toEqual([
      ["hourly", undefined],
      ["weekly", undefined],
      ["weekly", "Fable"],
      ["monthly", undefined],
      ["custom", undefined],
    ]);
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
      credential: () => "key",
      history: () => Promise.reject(new Error("history is unreadable")),
      id: "failing",
      limits: async () => ({ limits: [], unsupported: "a key has no limits" }),
    });
    usage.add(provider({ dir: "broken", name: "broken" }));
    usage.add(provider({ dir: "fine", name: "fine" }));
    usage.add(failing());
    const [broken, fine, unsupported] = await usage.query();

    expect(broken).toMatchObject({
      failed: "401 from the provider",
      windows: [],
    });
    expect(broken?.identity).toBeUndefined();
    expect(broken?.consumption?.total).toEqual({ outputTokens: 10 });
    expect(fine?.failed).toBeUndefined();
    expect(fine?.weekly?.usedPercent).toBe(53);
    expect(unsupported).toMatchObject({
      consumptionFailed: "history is unreadable",
      unsupported: "a key has no limits",
      windows: [],
    });
    expect(unsupported?.failed).toBeUndefined();
    expect(unsupported?.consumption).toBeUndefined();
  });

  it("reads a day of history by default, or since a date or span", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { asked, provider, usage } = setup();
    usage.add(provider());
    const exact = new Date("2026-10-01T00:00:00Z");

    await usage.query("fake");
    await usage.query({ since: "7d" });
    await usage.query("fake", { since: exact });
    await expect(usage.query({ since: "soon" as "7d" })).rejects.toThrow(
      "soon"
    );

    expect(asked.history).toEqual([
      new Date(NOW.getTime() - DAY),
      new Date(NOW.getTime() - 7 * DAY),
      exact,
    ]);
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
