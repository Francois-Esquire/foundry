import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import packageJson from "../../package.json";
// biome-ignore lint/performance/noNamespaceImport: This test inspects the complete public export surface.
import * as authorization from "../authorization";

const SUSPEND_CALL_PATTERN = /\bsuspend\s*[(:]/;

const AUTHORIZATION_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../authorization"
);

const PUBLIC_VALUES = [
  "AUTHORIZATION_ADDRESS_SCHEMA",
  "AUTHORIZATION_ADDRESS_VERSION",
  "CertificateVersionError",
  "GrantClaimError",
  "GrantRevisionError",
  "authorizationAddress",
  "certificateForProfile",
  "createAuthorizer",
  "createMemoryCertificateRepository",
  "createMemoryGrantRepository",
  "encodeAddress",
  "resolvePolicy",
];

function sourceFiles(): string[] {
  return readdirSync(AUTHORIZATION_DIR)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => join(AUTHORIZATION_DIR, entry));
}

describe("@foundry/lib/authorization public surface", () => {
  it("exports exactly the curated set", () => {
    expect(Object.keys(authorization).sort()).toEqual(PUBLIC_VALUES);
  });

  it("exports the authorizer and its reference adapters as callables", () => {
    expect(authorization.createAuthorizer).toBeTypeOf("function");
    expect(authorization.createMemoryGrantRepository).toBeTypeOf("function");
    expect(authorization.createMemoryCertificateRepository).toBeTypeOf(
      "function"
    );
  });

  it("declares the address schema it stamps", () => {
    expect(authorization.AUTHORIZATION_ADDRESS_SCHEMA).toBe(
      "foundry.authorization"
    );
    expect(authorization.AUTHORIZATION_ADDRESS_VERSION).toBe(1);
  });

  it("is reachable as its own subpath", () => {
    expect(packageJson.exports).toHaveProperty("./authorization");
  });

  it("owns no suspend port — authorization decides, execution waits", () => {
    for (const file of sourceFiles()) {
      expect(readFileSync(file, "utf8")).not.toMatch(SUSPEND_CALL_PATTERN);
    }
  });
});
