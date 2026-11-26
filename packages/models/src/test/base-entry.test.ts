import { fileURLToPath } from "node:url";
import { assertWebStandardExports } from "@foundry/lib/testing/seam";
import { expect, it } from "vitest";
import packageJson from "../../package.json";

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));

const WEB_STANDARD = [
  ".",
  "./providers/gateway",
  "./providers/vercel",
  "./cost",
  "./catalog/models-dev",
  "./catalog/models-dev-source",
];

const NODE_ONLY = [
  "./providers/claude-code",
  "./providers/codex",
  "./providers/pi",
];

it("publishes exactly the intended subpaths", () => {
  expect(Object.keys(packageJson.exports).sort()).toEqual(
    [...WEB_STANDARD, ...NODE_ONLY].sort()
  );
});

it("keeps every web-safe subpath free of Node and Bun dependencies", () => {
  expect(() =>
    assertWebStandardExports(PACKAGE_DIR, WEB_STANDARD)
  ).not.toThrow();
});
