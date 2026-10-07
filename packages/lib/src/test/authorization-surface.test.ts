import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import packageJson from "../../package.json";
// biome-ignore lint/performance/noNamespaceImport: This test inspects the complete public export surface.
import * as authorization from "../config/authorization";
import { addressDigest } from "../config/authorization/digest";
import { FileGrantRepository } from "../config/authorization/file";

const SUSPEND_CALL_PATTERN = /\bsuspend\s*[(:]/;

/**
 * The authorization module's structural claims, pinned rather than asserted in
 * prose.
 *
 * 1. **The public surface is curated.** Everything a host needs is exported and
 *    nothing else is, so widening it is a deliberate edit rather than a
 *    side effect of adding a file.
 * 2. **It is generic.** It imports no host vocabulary — not agents, not
 *    modules, not workflows, not persistence. That independence is what lets
 *    one mechanism serve all of them.
 * 3. **It does not depend on the module it replaces.** `config/policy` is a
 *    compatibility namespace scheduled for deletion; an import from here would
 *    make deleting it a change to authorization.
 * 4. **It is renderer-importable.** A host's approval UI reaches this
 *    vocabulary through `@foundry/agents/authorization`, and a bundler serving
 *    unbundled ESM evaluates every re-export on the way — so one `node:*`
 *    import anywhere in the barrel's graph throws in a browser before any of it
 *    runs, called or not. `digest.ts` and the file-backed grant repository in
 *    `file.ts` are the only exceptions, and are kept off the barrel for that
 *    reason.
 */

/** The node-bound modules, each reached by its own subpath and never through the barrel. */
const NODE_BOUND = ["digest.ts", "file.ts"];

const AUTHORIZATION_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../config/authorization"
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
  "createInMemoryCertificateRepository",
  "createInMemoryGrantRepository",
  "encodeAddress",
  "resolvePolicy",
];

/** Anything that would make authorization know a host, a substrate, or its predecessor. */
const FORBIDDEN_IMPORTS = [
  "@foundry/agents",
  "@foundry/modules",
  "@foundry/workflows",
  "@foundry/models",
  "@foundry/db",
  "@foundry/database",
  "@foundry/sandbox",
  "../policy",
];

function sourceFiles(): string[] {
  return readdirSync(AUTHORIZATION_DIR)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => join(AUTHORIZATION_DIR, entry));
}

describe("@foundry/lib/config/authorization public surface", () => {
  it("exports exactly the curated set", () => {
    expect(Object.keys(authorization).sort()).toEqual(PUBLIC_VALUES);
  });

  it("exports the authorizer and its reference adapters as callables", () => {
    expect(authorization.createAuthorizer).toBeTypeOf("function");
    expect(authorization.createInMemoryGrantRepository).toBeTypeOf("function");
    expect(authorization.createInMemoryCertificateRepository).toBeTypeOf(
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
    expect(packageJson.exports).toHaveProperty("./config/authorization");
    expect(packageJson.exports["./config/authorization"].import).toBe(
      "./src/config/authorization/index.ts"
    );
  });
});

describe("@foundry/lib/config/authorization boundaries", () => {
  it("knows no host vocabulary, substrate, or predecessor", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of FORBIDDEN_IMPORTS) {
        if (source.includes(`from "${forbidden}`)) {
          offenders.push(`${file} imports ${forbidden}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("depends only on Core contracts, never consuming packages", () => {
    expect(packageJson.dependencies).toEqual({
      "@foundry/core": "workspace:*",
    });
    expect(
      Object.keys(packageJson.peerDependencies).filter((name) =>
        name.startsWith("@foundry/")
      )
    ).toEqual([]);
  });

  it("stays renderer-importable — no node builtin reachable from the barrel", () => {
    const offenders = sourceFiles()
      .filter((file) => !NODE_BOUND.some((name) => file.endsWith(`/${name}`)))
      .filter((file) => readFileSync(file, "utf8").includes('from "node:'));

    expect(offenders).toEqual([]);
  });

  it("keeps the node-bound modules off the barrel", () => {
    expect(Object.keys(authorization)).not.toContain("addressDigest");
    expect(Object.keys(authorization)).not.toContain("FileGrantRepository");
    expect(addressDigest).toBeTypeOf("function");
    expect(FileGrantRepository).toBeTypeOf("function");
    const barrel = readFileSync(join(AUTHORIZATION_DIR, "index.ts"), "utf8");
    for (const name of NODE_BOUND) {
      expect(barrel).not.toContain(`"./${name.replace(".ts", "")}"`);
    }
  });

  it("owns no suspend port — authorization decides, execution waits", () => {
    for (const file of sourceFiles()) {
      expect(readFileSync(file, "utf8")).not.toMatch(SUSPEND_CALL_PATTERN);
    }
  });
});
