import { expect, it } from "vitest";
import packageJson from "../../package.json";

const EXPECTED_SUBPATHS = [
  ".",
  "./catalog/models-dev",
  "./catalog/models-dev-source",
  "./cost",
  "./providers/claude-code",
  "./providers/codex",
  "./providers/gateway",
  "./providers/pi",
  "./providers/vercel",
];

it("publishes exactly the intended subpaths", () => {
  expect(Object.keys(packageJson.exports).sort()).toEqual(EXPECTED_SUBPATHS);
});
