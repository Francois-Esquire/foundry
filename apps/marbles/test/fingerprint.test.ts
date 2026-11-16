import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileDigests,
  fingerprintOf,
  installationDigest,
  printNow,
  sourceDigests,
  treeDigest,
  withRead,
} from "~/process/fingerprint";
import { temporaryDirectory } from "./helpers/temporary";

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
  it("covers every file under the root, read or not, and each file a load read outside it", () => {
    const dir = temporaryDirectory("marbles-fingerprint-");
    const root = join(dir, "project");
    const shared = join(dir, "shared");
    mkdirSync(root);
    mkdirSync(shared);
    const config = join(root, "marbles.config.ts");
    const helper = join(root, "helper.ts");
    const outside = join(shared, "values.json");
    writeFileSync(config, 'import "./helper.ts";\n');
    writeFileSync(helper, "export const value = 1;\n");
    writeFileSync(outside, '{ "value": 1 }\n');
    const records = [{ config, id: "w", root }];
    const read = new Map([["w", [config, helper, outside]]]);
    const digest = () => sourceDigests(records, read).get("w");

    const before = digest();
    writeFileSync(helper, "export const value = 200;\n");
    const helped = digest();
    expect(helped).not.toBe(before);
    writeFileSync(outside, '{ "value": 200 }\n');
    const data = digest();
    expect(data).not.toBe(helped);
    writeFileSync(join(root, "later.ts"), "export {};\n");
    const later = digest();
    expect(later).not.toBe(data);
    writeFileSync(join(shared, "unread.ts"), "export {};\n");
    expect(digest()).toBe(later);
  });

  it("leaves out what a run writes under the root that no load could read", () => {
    const root = join(temporaryDirectory("marbles-fingerprint-"), "project");
    mkdirSync(root);
    const config = join(root, "marbles.config.ts");
    writeFileSync(config, "export {};\n");
    const records = [{ config, id: "w", root }];
    const before = sourceDigests(records, new Map()).get("w");
    writeFileSync(join(root, "seen.jsonl"), "{}\n");
    writeFileSync(join(root, "report.md"), "# done\n");
    expect(sourceDigests(records, new Map()).get("w")).toBe(before);
    writeFileSync(join(root, "values.json"), "{}\n");
    expect(sourceDigests(records, new Map()).get("w")).not.toBe(before);
  });

  it("leaves out dependencies, history, Marbles' own and builds", () => {
    const root = join(temporaryDirectory("marbles-fingerprint-"), "project");
    for (const name of ["node_modules", ".git", ".marbles", "dist"]) {
      mkdirSync(join(root, name), { recursive: true });
    }
    const config = join(root, "marbles.config.ts");
    writeFileSync(config, "export {};\n");
    const records = [{ config, id: "w", root }];
    const before = sourceDigests(records, new Map()).get("w");
    for (const name of ["node_modules", ".git", ".marbles", "dist"]) {
      writeFileSync(join(root, name, "file.js"), "changed\n");
    }
    expect(sourceDigests(records, new Map()).get("w")).toBe(before);
  });
});

describe("treeDigest", () => {
  it("names files by their path under the root, so another spelling of the root changes nothing", () => {
    const dir = temporaryDirectory("marbles-fingerprint-");
    const one = join(dir, "one");
    const two = join(dir, "two");
    for (const root of [one, two]) {
      mkdirSync(join(root, "lib"), { recursive: true });
      writeFileSync(join(root, "marbles.config.ts"), "export {};\n");
      writeFileSync(join(root, "lib", "helper.ts"), "export const a = 1;\n");
    }
    const digests = new FileDigests();
    const of = (root: string) =>
      treeDigest(
        { config: join(root, "marbles.config.ts"), id: "w", root },
        digests
      );
    expect(of(one)).toBe(of(two));
  });

  it("follows content, not modification time: a file touched but unchanged changes nothing", () => {
    const root = join(temporaryDirectory("marbles-fingerprint-"), "project");
    mkdirSync(root);
    const config = join(root, "marbles.config.ts");
    writeFileSync(config, "export const a = 1;\n");
    const digests = new FileDigests();
    const registration = { config, id: "w", root };
    const before = treeDigest(registration, digests);
    const later = new Date(Date.now() + 60_000);
    utimesSync(config, later, later);
    expect(treeDigest(registration, digests)).toBe(before);
    writeFileSync(config, "export const a = 2;\n");
    utimesSync(config, later, new Date(Date.now() + 120_000));
    expect(treeDigest(registration, digests)).not.toBe(before);
  });
});

describe("withRead", () => {
  it("records a file read outside the root as read, or as changed when it moved after the read", () => {
    const dir = temporaryDirectory("marbles-fingerprint-");
    const root = join(dir, "project");
    mkdirSync(root);
    const config = join(root, "marbles.config.ts");
    writeFileSync(config, "export {};\n");
    const outside = join(dir, "helper.ts");
    writeFileSync(outside, "export const a = 1;\n");
    const digests = new FileDigests();
    const registration = { config, id: "w", root };
    const empty = printNow(registration, [], digests);
    const now = printNow(registration, [outside], digests);

    const read = withRead(empty, outside, Date.now() + 60_000, digests);
    expect(fingerprintOf("", new Map([["w", read]])).digest).toBe(
      fingerprintOf("", new Map([["w", now]])).digest
    );
    const stale = withRead(empty, outside, 0, digests);
    expect(fingerprintOf("", new Map([["w", stale]])).digest).not.toBe(
      fingerprintOf("", new Map([["w", now]])).digest
    );
    expect(withRead(empty, config, 0, digests)).toBe(empty);
  });
});

describe("withRead under the root", () => {
  it("records a file a load read under the root that the tree does not cover, as a text import", () => {
    const root = join(temporaryDirectory("marbles-fingerprint-"), "project");
    mkdirSync(root);
    const config = join(root, "marbles.config.ts");
    const prompt = join(root, "prompt.md");
    writeFileSync(
      config,
      'import prompt from "./prompt.md" with { type: "text" };\n'
    );
    writeFileSync(prompt, "Say hello.\n");
    const digests = new FileDigests();
    const registration = { config, id: "w", root };
    const empty = printNow(registration, [], digests);
    const read = withRead(empty, prompt, Date.now() + 60_000, digests);
    const digestOf = (outside: readonly string[]) =>
      fingerprintOf(
        "",
        new Map([["w", printNow(registration, outside, digests)]])
      ).digest;
    expect(fingerprintOf("", new Map([["w", read]])).digest).toBe(
      digestOf([...read.outside.keys()])
    );
    writeFileSync(prompt, "Say goodbye, at length.\n");
    expect(digestOf([...read.outside.keys()])).not.toBe(
      fingerprintOf("", new Map([["w", read]])).digest
    );
    expect(withRead(read, config, 0, digests)).toBe(read);
  });
});

describe("fingerprintOf", () => {
  it("is the same for the same sources in any order, and differs when one changes", () => {
    const part = (tree: string) => ({
      files: new Map<string, string>(),
      outside: new Map<string, string>(),
      root: "",
      tree,
    });
    const one = fingerprintOf(
      "install",
      new Map([
        ["a", part("1")],
        ["b", part("2")],
      ])
    );
    const swapped = fingerprintOf(
      "install",
      new Map([
        ["b", part("2")],
        ["a", part("1")],
      ])
    );
    expect(swapped.digest).toBe(one.digest);
    expect(
      fingerprintOf(
        "install",
        new Map([
          ["a", part("1")],
          ["b", part("3")],
        ])
      ).digest
    ).not.toBe(one.digest);
    expect(fingerprintOf("other", one.sources).digest).not.toBe(one.digest);
  });
});
