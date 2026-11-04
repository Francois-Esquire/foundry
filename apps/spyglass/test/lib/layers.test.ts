import { cruise } from "dependency-cruiser";
import extractDepcruiseOptions from "dependency-cruiser/config-utl/extract-depcruise-options";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import { expect, it } from "vitest";

// The viewer's layer direction, declared in .dependency-cruiser.cjs. The
// cruise resolves paths from the package directory, as its CLI does.
it("keeps the viewer's layers and the visualization library in their direction", async () => {
  const options = await extractDepcruiseOptions("./.dependency-cruiser.cjs");
  const tsConfig = extractTSConfig("tsconfig.json");
  const result = await cruise(
    ["src/web", "src/lib/visualization"],
    options,
    undefined,
    { tsConfig }
  );
  if (typeof result.output === "string") {
    throw new Error("dependency-cruiser returned a report, not its result");
  }
  const violations = result.output.summary.violations.map(
    ({ from, rule, to }) => `${rule.name}: ${from} -> ${to}`
  );
  expect(violations).toEqual([]);
  expect(result.output.summary.totalCruised).toBeGreaterThan(0);
});
