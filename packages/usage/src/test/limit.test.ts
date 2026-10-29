import { describe, expect, it } from "vitest";

import {
  type Balance,
  type CreditBalance,
  exhausted,
  headroom,
  resetsIn,
  type SpendCap,
  type Window,
} from "../index";

const HOUR = 3_600_000;
const now = new Date("2026-10-29T12:00:00Z");
const inTwoHours = new Date(now.getTime() + 2 * HOUR);
const usd = (amount: number) => ({ amount, unit: "usd" }) as const;

const weekly: Window = {
  id: "weekly-window",
  kind: "window",
  resetsAt: inTwoHours,
  span: 168 * HOUR,
  usedPercent: 46,
};
const cap: SpendCap = {
  cap: usd(200),
  kind: "spend-cap",
  resetsAt: inTwoHours,
  used: usd(150),
};
const balance: Balance = { kind: "balance", remaining: usd(25) };
const credits: CreditBalance = {
  expiresAt: inTwoHours,
  kind: "credit-balance",
  remaining: 300,
};

describe("headroom", () => {
  it("gives a window its percent left and a share", () => {
    expect(headroom(weekly)).toEqual({
      remaining: 54,
      share: 0.54,
      unit: "percent",
    });
    // The README's check typechecks as written: a window always has a share.
    const found = [weekly].find((limit) => limit.id === "weekly-window");
    expect(found && headroom(found).share < 0.1).toBe(false);
  });

  it("gives a spend cap its money left and a share", () => {
    expect(headroom(cap)).toEqual({ remaining: 50, share: 0.25, unit: "usd" });
  });

  it("gives balances an amount and no share", () => {
    expect(headroom(balance)).toEqual({ remaining: 25, unit: "usd" });
    expect(headroom(credits)).toEqual({ remaining: 300, unit: "credits" });
  });

  it("never goes below zero", () => {
    expect(headroom({ ...weekly, usedPercent: 120 }).remaining).toBe(0);
    expect(headroom({ ...cap, used: usd(250) }).share).toBe(0);
  });
});

describe("resetsIn", () => {
  it("is the time until a window or spend cap resets", () => {
    expect(resetsIn(weekly, now)).toBe(2 * HOUR);
    expect(resetsIn(cap, now)).toBe(2 * HOUR);
    expect(resetsIn(weekly, new Date(inTwoHours.getTime() + HOUR))).toBe(0);
  });

  it("is undefined when a limit never resets", () => {
    expect(resetsIn({ ...weekly, resetsAt: undefined }, now)).toBeUndefined();
    expect(resetsIn(balance, now)).toBeUndefined();
    expect(resetsIn(credits, now)).toBeUndefined();
  });
});

describe("exhausted", () => {
  it("is true only when no headroom is left", () => {
    expect(exhausted(weekly)).toBe(false);
    expect(exhausted({ ...weekly, usedPercent: 100 })).toBe(true);
    expect(exhausted(cap)).toBe(false);
    expect(exhausted({ ...cap, used: usd(200) })).toBe(true);
    expect(exhausted(balance)).toBe(false);
    expect(exhausted({ ...balance, remaining: usd(0) })).toBe(true);
    expect(exhausted(credits)).toBe(false);
    expect(exhausted({ ...credits, remaining: 0 })).toBe(true);
  });
});
