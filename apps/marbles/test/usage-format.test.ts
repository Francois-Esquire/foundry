import { expect, it } from "vitest";
import type { Money, UsageTotal } from "~/model/usage";
import { costCell, costLabel } from "~/views/usage-format";

/** One fully priced turn costing `money`. */
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
