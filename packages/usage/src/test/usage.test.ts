import type {
  Consumption,
  Credential,
  Provider,
  Reading,
} from "@foundry/usage";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createUsage } from "../usage";

declare module "@foundry/usage" {
  interface ProviderDetails {
    readonly fake?: { readonly tier: string };
  }
}

const DAY = 86_400_000;

const login = (dir: string, provider = "fake"): Credential => ({
  id: dir,
  provider,
});

const reading = (accountId: string): Reading => ({
  account: { id: accountId, plan: "max" },
  details: { fake: { tier: "gold" } },
  limits: [
    { id: "weekly-window", kind: "window", span: 7 * DAY, usedPercent: 46 },
  ],
});

const history = (since: Date, session: string): Consumption => ({
  bySession: [{ model: "m", quantities: { outputTokens: 10 }, session }],
  charge: { amount: { amount: 1, unit: "usd" }, basis: "notional" },
  since,
  total: { outputTokens: 10 },
});

interface FakeOptions {
  readonly detected?: readonly Credential[];
  readonly id?: string;
  readonly limits?: (credential: Credential) => Reading;
}

const fakeProvider = (options: FakeOptions = {}) => {
  const asked = { history: [] as Date[], limits: [] as string[] };
  const provider: Provider = {
    detect: async () => options.detected ?? [],
    history: async (credential, since) => {
      asked.history.push(since);
      return history(since, credential.id);
    },
    id: options.id ?? "fake",
    limits: async (credential) => {
      asked.limits.push(credential.id);
      return options.limits?.(credential) ?? reading(credential.id);
    },
  };
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
  it("detect adds what providers find and asks for no limits", async () => {
    const { asked, usage } = setup({ detected: [login("a"), login("b")] });
    const accounts = await usage.detect();
    await usage.detect();

    expect(accounts.map((account) => account.credential.id)).toEqual([
      "a",
      "b",
    ]);
    expect(asked.limits).toEqual([]);
    await usage.query();
    expect(asked.limits).toEqual(["a", "b"]);
  });

  it("add returns the same account for the same credential", () => {
    const { usage } = setup();
    expect(usage.add(login("a"))).toBe(usage.add(login("a")));
  });

  it("rejects unknown and duplicate providers", () => {
    const { provider, usage } = setup();
    expect(() => usage.add(login("a", "nobody"))).toThrow("nobody");
    expect(() => usage.use(provider)).toThrow("fake");
  });
});

describe("querying", () => {
  it("reads every account's limits and consumption, fresh each time", async () => {
    const { asked, usage } = setup();
    const work = usage.add(login("work"));
    const first = await usage.query();
    await usage.query();

    const account = first.of(work);
    expect(account?.provider).toBe("fake");
    expect(account?.account).toEqual({ id: "work", plan: "max" });
    expect(account?.window("weekly-window")?.usedPercent).toBe(46);
    expect(account?.window("five-hour-window")).toBeUndefined();
    expect(account?.consumption?.total).toEqual({ outputTokens: 10 });
    expect(asked.limits).toEqual(["work", "work"]);
  });

  it("stamps readAt before asking and at after the query", async () => {
    const asked = new Date("2026-10-29T12:00:00Z");
    const answered = new Date("2026-10-29T12:00:02Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(asked);
    const { usage } = setup({
      limits: (credential) => {
        vi.setSystemTime(answered);
        return reading(credential.id);
      },
    });
    const work = usage.add(login("work"));
    const snapshot = await usage.query();

    expect(snapshot.of(work)?.readAt).toEqual(asked);
    expect(snapshot.at).toEqual(answered);
  });

  it("reports a failed read for that account only", async () => {
    const { usage } = setup({
      limits: (credential) => {
        if (credential.id === "broken") {
          throw new Error("401 from the provider");
        }
        return reading(credential.id);
      },
    });
    const broken = usage.add(login("broken"));
    const fine = usage.add(login("fine"));
    const snapshot = await usage.query();

    expect(snapshot.of(broken)).toMatchObject({
      failed: "401 from the provider",
      limits: [],
    });
    expect(snapshot.of(broken)?.consumption).toBeUndefined();
    expect(snapshot.of(fine)?.failed).toBeUndefined();
    expect(snapshot.of(fine)?.limits).toHaveLength(1);
  });

  it("reports a credential that never has limits as unsupported", async () => {
    const { usage } = setup({
      limits: () => ({ limits: [], unsupported: "an API key has no limits" }),
    });
    const key = usage.add(login("key"));
    const snapshot = await usage.query();

    expect(snapshot.of(key)).toMatchObject({
      limits: [],
      unsupported: "an API key has no limits",
    });
    expect(snapshot.of(key)?.failed).toBeUndefined();
  });

  it("shows two credentials that reach one account as one account", async () => {
    const { usage } = setup({ limits: () => reading("same") });
    const home = usage.add(login("home"));
    const work = usage.add(login("work"));
    const snapshot = await usage.query();

    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.of(home)).toBe(snapshot.of(work));
    const consumption = snapshot.of(home)?.consumption;
    expect(consumption?.total).toEqual({ outputTokens: 20 });
    expect(consumption?.charge?.amount).toEqual({ amount: 2, unit: "usd" });
    expect(consumption?.bySession.map((entry) => entry.session)).toEqual([
      "home",
      "work",
    ]);
  });

  it("passes since to history", async () => {
    const now = new Date("2026-10-29T12:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const { asked, usage } = setup();
    usage.add(login("a"));
    const exact = new Date("2026-10-01T00:00:00Z");

    await usage.query({ since: "7d" });
    await usage.query({ since: exact });
    await usage.query();
    await expect(usage.query({ since: "soon" as "7d" })).rejects.toThrow(
      "soon"
    );

    expect(asked.history).toEqual([
      new Date(now.getTime() - 7 * DAY),
      exact,
      new Date(0),
    ]);
  });

  it("selects accounts and providers", async () => {
    const { usage } = setup();
    const other = fakeProvider({ id: "other" });
    usage.use(other.provider);
    const a = usage.add(login("a"));
    const b = usage.add(login("b"));
    const c = usage.add(login("c", "other"));

    const justA = await usage.query({ accounts: [a] });
    const justOther = await usage.query({ provider: "other" });
    const both = await usage.query({ accounts: [a, c], provider: "fake" });

    expect(justA.accounts).toHaveLength(1);
    expect(justA.of(b)).toBeUndefined();
    expect(justOther.accounts.map((account) => account.provider)).toEqual([
      "other",
    ]);
    expect(justOther.of(c)).toBeDefined();
    expect(both.accounts).toHaveLength(1);
    expect(both.of(a)).toBeDefined();
  });

  it("types a provider's details through declaration merging", async () => {
    const { usage } = setup();
    const work = usage.add(login("work"));
    const details = (await usage.query()).of(work)?.details;

    expect(details?.fake?.tier).toBe("gold");
    expectTypeOf(details?.fake?.tier).toEqualTypeOf<string | undefined>();
    // @ts-expect-error: no provider declared "unknown" details.
    expect(details?.unknown).toBeUndefined();
  });
});
