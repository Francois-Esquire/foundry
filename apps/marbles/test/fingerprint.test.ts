import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rebuildLinks, relinkArtifact } from "~/database/links";
import type { ResourceView } from "~/database/resources";
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
    // Under the root, whether a load read it or not: a run may import it.
    writeFileSync(join(root, "later.ts"), "export {};\n");
    const later = digest();
    expect(later).not.toBe(data);
    // Outside the root, and read by no load: not part of it.
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

describe("a workspace's links", () => {
  it("never change its fingerprint as they are made, replaced, pruned and locked", async () => {
    const home = temporaryDirectory("marbles-fingerprint-");
    const root = join(home, "project");
    mkdirSync(root);
    const config = join(root, "marbles.config.ts");
    writeFileSync(config, "export {};\n");
    const artifacts = join(home, "artifacts");
    const blobs = join(artifacts, "workspaces", "w", "blobs");
    mkdirSync(blobs, { recursive: true });
    writeFileSync(join(blobs, "old"), "old\n");
    writeFileSync(join(blobs, "new"), "new\n");
    const records = [{ config, id: "w", root }];
    const digest = () => sourceDigests(records, new Map()).get("w");
    const before = digest();
    const ref = { id: "notes", kind: "artifact", owner: "w" } as const;
    const view = {
      artifactFiles: () => Promise.resolve([{ blob: "old", path: "a.md" }]),
      artifacts: () => Promise.resolve([{ ref }]),
    } as unknown as ResourceView;
    await rebuildLinks({ artifacts, root, view, workspace: "w" });
    expect(
      existsSync(join(root, ".marbles", "artifacts", "notes", "a.md"))
    ).toBe(true);
    expect(digest()).toBe(before);
    await relinkArtifact({
      artifacts,
      files: [{ blob: "new", path: "a.md" }],
      ref,
      root,
      workspace: "w",
    });
    expect(digest()).toBe(before);
    await relinkArtifact({ artifacts, files: [], ref, root, workspace: "w" });
    expect(existsSync(join(root, ".marbles", "artifacts", "notes"))).toBe(
      false
    );
    expect(digest()).toBe(before);
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
    // Same size, new content: read again because its time moved.
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

    // Read after its last change: recorded as it is, the same as now.
    const read = withRead(
      registration,
      empty,
      outside,
      Date.now() + 60_000,
      digests
    );
    expect(fingerprintOf("", new Map([["w", read]])).digest).toBe(
      fingerprintOf("", new Map([["w", now]])).digest
    );
    // Changed since it was read: matches nothing, so a switch follows.
    const stale = withRead(registration, empty, outside, 0, digests);
    expect(fingerprintOf("", new Map([["w", stale]])).digest).not.toBe(
      fingerprintOf("", new Map([["w", now]])).digest
    );
    // A file under the root is the tree's.
    expect(withRead(registration, empty, config, 0, digests)).toBe(empty);
  });
});

describe("fingerprintOf", () => {
  it("is the same for the same sources in any order, and differs when one changes", () => {
    const part = (tree: string) => ({
      outside: new Map<string, string>(),
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
