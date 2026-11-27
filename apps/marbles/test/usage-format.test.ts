import { expect, it } from "vitest";
import type { Money, UsageTotal, WorkspaceUsage } from "~/model/usage";
import {
  costCell,
  costLabel,
  costView,
  tokensLabel,
  usageBreakdown,
} from "~/tui/state/usage-format";

function priced(money: Money, basis: "estimated" | "reported"): UsageTotal {
  return {
    estimated: basis === "estimated" ? [money] : [],
    missing: 0,
    reported: basis === "reported" ? [money] : [],
    tokens: { cachedInput: 0, cacheWrite: 0, input: 1, output: 1, total: 2 },
    turns: 1,
    unattributed: 0,
    unpriced: 0,
    unreadable: 0,
    untokened: 0,
  };
}

it("bounds a positive cost too small to show at four places, in any currency, instead of reading as zero", () => {
  expect(
    costLabel(priced({ amount: 0.000_04, currency: "USD" }, "estimated"))
  ).toBe("<$0.0001 est.");
  expect(costLabel(priced({ amount: 1e-9, currency: "USD" }, "reported"))).toBe(
    "<$0.0001 reported"
  );
  expect(
    costLabel(priced({ amount: 0.000_01, currency: "EUR" }, "estimated"))
  ).toBe("<0.0001 EUR est.");
  expect(
    costCell(priced({ amount: 0.000_04, currency: "USD" }, "estimated"))
  ).toBe("~<$0.0001");
  expect(
    costCell(priced({ amount: 0.000_04, currency: "USD" }, "reported"))
  ).toBe("<$0.0001");
});

it("keeps a cost that rounds to a shown digit, a true zero, and the two-place form at a dollar and above", () => {
  expect(
    costLabel(priced({ amount: 0.000_05, currency: "USD" }, "estimated"))
  ).toBe("$0.0001 est.");
  expect(
    costLabel(priced({ amount: 0.0001, currency: "USD" }, "estimated"))
  ).toBe("$0.0001 est.");
  expect(costLabel(priced({ amount: 0, currency: "USD" }, "reported"))).toBe(
    "$0.0000 reported"
  );
  expect(
    costLabel(priced({ amount: 0.0421, currency: "USD" }, "estimated"))
  ).toBe("$0.0421 est.");
  expect(costLabel(priced({ amount: 1.2, currency: "USD" }, "reported"))).toBe(
    "$1.20 reported"
  );
  expect(costLabel(priced({ amount: 3, currency: "EUR" }, "estimated"))).toBe(
    "3.00 EUR est."
  );
});

it("marks only priced cells as priced", () => {
  expect(costView("$1.00")).toEqual({ priced: true, value: "$1.00" });
  expect(costView("cost ?")).toEqual({ priced: false, value: "cost ?" });
});

it("labels a workspace breakdown and leaves out empty work outside runs", () => {
  const spent = priced({ amount: 1, currency: "USD" }, "reported");
  const idle: UsageTotal = {
    ...spent,
    reported: [],
    tokens: { ...spent.tokens, input: 0, output: 0, total: 0 },
    turns: 0,
  };
  const usage: WorkspaceUsage = {
    byAgent: [{ id: "writer", total: spent }],
    byWorkflow: [],
    outsideRuns: idle,
    recovered: 1,
    total: spent,
    unattributed: 2,
    unreadable: 3,
    unsaved: 4,
  };
  const line = { cost: costLabel(spent), tokens: tokensLabel(spent) };
  expect(usageBreakdown(usage)).toEqual({
    byAgent: [{ id: "writer", ...line }],
    byWorkflow: [],
    recovered: 1,
    total: line,
    unattributed: 2,
    unreadable: 3,
    unsaved: 4,
  });
  expect(usageBreakdown({ ...usage, outsideRuns: spent }).outsideRuns).toBe(
    costLabel(spent)
  );
});
