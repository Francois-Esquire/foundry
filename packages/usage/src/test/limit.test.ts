import { balance, credits, spendCap, window } from "@foundry/usage/provider";
import { describe, expect, it } from "vitest";

import { resolve } from "../limit";

const HOUR = 3_600_000;
const now = new Date("2026-10-29T12:00:00Z");
const inTwoHours = new Date(now.getTime() + 2 * HOUR);

describe("the kit's builders", () => {
  it("make windows by span, clamped, with no undefined fields", () => {
    expect(window.hourly({ hours: 5, usedPercent: 140 })).toEqual({
      duration: 5 * HOUR,
      kind: "window",
      span: "hourly",
      usedPercent: 100,
    });
    expect(
      Object.keys(window.weekly({ resetsAt: undefined, usedPercent: 1 }))
    ).not.toContain("resetsAt");
    expect(window.weekly({ model: "Fable", usedPercent: -5 })).toMatchObject({
      duration: 168 * HOUR,
      model: "Fable",
      usedPercent: 0,
    });
    expect(window.custom({ duration: HOUR, usedPercent: 3 }).duration).toBe(
      HOUR
    );
  });

  it("make money limits in dollars and credits in the provider's unit", () => {
    expect(spendCap({ cap: 400, used: 12.5 })).toEqual({
      cap: { amount: 400, unit: "usd" },
      kind: "spend-cap",
      used: { amount: 12.5, unit: "usd" },
    });
    expect(balance({ remaining: 25 })).toEqual({
      kind: "balance",
      remaining: { amount: 25, unit: "usd" },
    });
    expect(credits({ remaining: 300 })).toEqual({
      kind: "credit-balance",
      remaining: 300,
    });
  });
});

// Headroom and resetsIn from `at` through a query are in usage.test.ts.
describe("resolving a limit", () => {
  it("gives a share only with a total, never goes below zero, and is exhausted with nothing left", () => {
    expect(resolve(window.weekly({ usedPercent: 100 }), now)).toMatchObject({
      exhausted: true,
      headroom: { remaining: 0, share: 0 },
    });
    expect(resolve(spendCap({ cap: 0, used: 5 }), now)).toMatchObject({
      exhausted: true,
      headroom: { remaining: 0, share: 0 },
    });
    expect(resolve(spendCap({ cap: 200, used: 150 }), now).headroom).toEqual({
      remaining: 50,
      share: 0.25,
      unit: "usd",
    });
    expect(resolve(balance({ remaining: -3 }), now)).toMatchObject({
      exhausted: true,
      headroom: { remaining: 0, unit: "usd" },
    });
    expect(resolve(credits({ remaining: 0 }), now).exhausted).toBe(true);
  });

  it("never resets in the past, and leaves resetsIn out when the limit never resets", () => {
    const weekly = window.weekly({ resetsAt: inTwoHours, usedPercent: 1 });
    expect(
      resolve(weekly, new Date(inTwoHours.getTime() + HOUR)).resetsIn
    ).toBe(0);
    expect(resolve(window.weekly({ usedPercent: 1 }), now)).not.toHaveProperty(
      "resetsIn"
    );
    expect(
      resolve(credits({ expiresAt: inTwoHours, remaining: 1 }), now)
    ).not.toHaveProperty("resetsIn");
  });
});
