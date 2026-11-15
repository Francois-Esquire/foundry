import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fingerprintOf,
  installationDigest,
  sourceDigests,
} from "~/process/fingerprint";
import { temporaryDirectory } from "./helpers/temporary";

/** A built installation: its generation entry, a chunk, a migration and a dot file. */
function build(): { readonly dist: string; readonly entry: string } {
  const dist = join(temporaryDirectory("marbles-fingerprint-"), "dist");
  mkdirSync(join(dist, "migrations"), { recursive: true });
  const entry = join(dist, "generation.js");
  writeFileSync(entry, 'import "./chunk-a.js";\n');
  writeFileSync(join(dist, "chunk-a.js"), "export {};\n");
  writeFileSync(join(dist, "migrations", "0000_init.sql"), "-- init\n");
  writeFileSync(join(dist, ".cache"), "x");
  return { dist, entry };
}

describe("installationDigest", () => {
  it("changes with any file of a build, and with the version, but not with a dot file", () => {
    const { dist, entry } = build();
    const before = installationDigest(entry, "1.0.0");
    expect(installationDigest(entry, "1.0.0")).toBe(before);
    expect(installationDigest(entry, "1.0.1")).not.toBe(before);

    writeFileSync(join(dist, ".cache"), "a dot file, rewritten");
    expect(installationDigest(entry, "1.0.0")).toBe(before);

    writeFileSync(join(dist, "chunk-a.js"), "export const changed = 1;\n");
    const chunked = installationDigest(entry, "1.0.0");
    expect(chunked).not.toBe(before);

    // Same size, a later modification time.
    const migration = join(dist, "migrations", "0000_init.sql");
    writeFileSync(migration, "-- edit\n");
    const later = new Date(Date.now() + 60_000);
    utimesSync(migration, later, later);
    expect(installationDigest(entry, "1.0.0")).not.toBe(chunked);
  });

  it("covers the whole source directory when run from source", () => {
    const src = join(temporaryDirectory("marbles-fingerprint-"), "src");
    mkdirSync(join(src, "process"), { recursive: true });
    mkdirSync(join(src, "lib"));
    const entry = join(src, "process", "generation.ts");
    writeFileSync(entry, "export {};\n");
    writeFileSync(join(src, "lib", "engine.ts"), "export {};\n");
    const before = installationDigest(entry, "1.0.0");
    writeFileSync(join(src, "lib", "engine.ts"), "export const changed = 1;\n");
    expect(installationDigest(entry, "1.0.0")).not.toBe(before);
  });
});

describe("sourceDigests", () => {
  it("covers every file the workspace's load read, wherever it is, beside its entries", () => {
    const dir = temporaryDirectory("marbles-fingerprint-");
    const root = join(dir, "project");
    const shared = join(dir, "shared");
    mkdirSync(root);
    mkdirSync(shared);
    const config = join(root, "marbles.config.ts");
    const helper = join(shared, "helper.ts");
    const data = join(shared, "values.json");
    writeFileSync(config, 'import "../shared/helper.ts";\n');
    writeFileSync(helper, "export const value = 1;\n");
    writeFileSync(data, '{ "value": 1 }\n');
    const records = [{ config, id: "w", root }];
    const read = new Map([["w", [config, helper, data]]]);
    const digest = () => sourceDigests(records, read).get("w");

    const before = digest();
    writeFileSync(helper, "export const value = 200;\n");
    const helped = digest();
    expect(helped).not.toBe(before);
    writeFileSync(data, '{ "value": 200 }\n');
    expect(digest()).not.toBe(helped);
    // Not read by its load: not part of it.
    const unread = join(shared, "unread.ts");
    const now = digest();
    writeFileSync(unread, "export {};\n");
    expect(digest()).toBe(now);
  });

  it("is its entries alone before any load read it", () => {
    const root = join(temporaryDirectory("marbles-fingerprint-"), "project");
    mkdirSync(root);
    const config = join(root, "marbles.config.ts");
    writeFileSync(config, "export {};\n");
    const records = [{ config, id: "w", root }];
    const before = sourceDigests(records, new Map()).get("w");
    writeFileSync(config, "export const changed = 1;\n");
    expect(sourceDigests(records, new Map()).get("w")).not.toBe(before);
  });
});

describe("fingerprintOf", () => {
  it("is the same for the same sources in any order, and differs when one changes", () => {
    const one = fingerprintOf(
      "install",
      new Map([
        ["a", "1"],
        ["b", "2"],
      ])
    );
    const swapped = fingerprintOf(
      "install",
      new Map([
        ["b", "2"],
        ["a", "1"],
      ])
    );
    expect(swapped.digest).toBe(one.digest);
    expect(
      fingerprintOf(
        "install",
        new Map([
          ["a", "1"],
          ["b", "3"],
        ])
      ).digest
    ).not.toBe(one.digest);
    expect(fingerprintOf("other", one.sources).digest).not.toBe(one.digest);
  });
});
