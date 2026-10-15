import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  recoverDirectory,
  replaceDirectory,
} from "../../src/lib/directory-publication";
import { analyzePackageLocal } from "../../src/lib/package-local";
import {
  lookupPackage,
  readCachedPackage,
  refreshPackageMeta,
  storePackage,
} from "../../src/lib/semantics-cache";

const publication = vi.hoisted(() => ({
  beforeRename: undefined as ((from: string, to: string) => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      publication.beforeRename?.(from, to);
      return actual.renameSync(from, to);
    },
  };
});

const temporary: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "spyglass-storage-"));
  temporary.push(path);
  return path;
}
afterEach(() => {
  publication.beforeRename = undefined;
  for (const path of temporary.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

it("publishes metadata and payload together and invalidates the old fingerprint", () => {
  const cache = directory();
  const local = analyzePackageLocal({
    root: join(import.meta.dirname, "fixtures/semantics"),
    target: "packages/b",
  });
  const entry = {
    analyzedAt: "test",
    components: {},
    id: "@s/b",
    kind: "package-local" as const,
    path: "packages/b",
    value: local,
  };
  storePackage(cache, { ...entry, fingerprint: "before" });
  const before = lookupPackage(cache, entry.id, entry.kind, "before");
  expect(before.hit).toBe(true);
  const changed = { ...local, symbols: [] };
  storePackage(cache, { ...entry, fingerprint: "after", value: changed });
  expect(lookupPackage(cache, entry.id, entry.kind, "before")).toMatchObject({
    hit: false,
    reason: "fingerprint-changed",
  });
  expect(lookupPackage(cache, entry.id, entry.kind, "after")).toMatchObject({
    hit: true,
    value: changed,
  });
  if (!before.hit) {
    throw new Error("missing initial entry");
  }
  refreshPackageMeta(cache, before.meta, {
    components: {},
    fingerprint: "stale-refresh",
  });
  expect(lookupPackage(cache, entry.id, entry.kind, "after")).toMatchObject({
    hit: true,
    value: changed,
  });
  expect(existsSync(join(cache, "packages/@s__b.local.json"))).toBe(false);
  const envelope = JSON.parse(
    readFileSync(join(cache, "packages/@s__b.local.meta.json"), "utf8")
  );
  expect(envelope).toMatchObject({ fingerprint: "after", value: changed });
  if (!before.hit) {
    throw new Error("missing initial entry");
  }
  const current = lookupPackage(cache, entry.id, entry.kind, "after");
  if (!current.hit) {
    throw new Error("missing current entry");
  }
  refreshPackageMeta(cache, current.meta, {
    components: { sources: "next" },
    fingerprint: "same-result",
  });
  expect(
    lookupPackage(cache, entry.id, entry.kind, "same-result")
  ).toMatchObject({ hit: true, value: changed });
  expect(readCachedPackage(cache, entry.id, entry.kind)).toEqual(changed);
});

it("replaces the dataset pointer while keeping the previous generation readable", () => {
  const root = directory();
  const output = join(root, "output");
  const stage = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(join(path, "manifest.json"), name);
    return path;
  };
  replaceDirectory(stage("first"), output);
  const previous = realpathSync(output);
  replaceDirectory(stage("second"), output);
  expect(lstatSync(output).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(output, "manifest.json"), "utf8")).toBe("second");
  expect(readFileSync(join(previous, "manifest.json"), "utf8")).toBe("first");
  expect(() => replaceDirectory(join(root, "missing"), output)).toThrow();
  expect(readFileSync(join(output, "manifest.json"), "utf8")).toBe("second");
});

it("recovers an interrupted legacy directory migration before discarding staging", () => {
  const root = directory();
  const output = join(root, "output");
  const backup = `${output}.old-2147483647`;
  mkdirSync(backup);
  writeFileSync(join(backup, "manifest.json"), "previous");
  recoverDirectory(output);
  expect(readFileSync(join(output, "manifest.json"), "utf8")).toBe("previous");
  expect(existsSync(backup)).toBe(false);
});

it("keeps the published generation when replacing its pointer fails", () => {
  const root = directory();
  const output = join(root, "output");
  const first = join(root, "first");
  const second = join(root, "second");
  for (const path of [first, second]) {
    mkdirSync(path);
    writeFileSync(join(path, "manifest.json"), path);
  }
  replaceDirectory(first, output);
  const previous = realpathSync(output);
  publication.beforeRename = (from, to) => {
    if (from.includes(".pointer-") && to === output) {
      expect(realpathSync(output)).toBe(previous);
      expect(readFileSync(join(output, "manifest.json"), "utf8")).toBe(first);
      throw new Error("pointer replacement failed");
    }
  };
  expect(() => replaceDirectory(second, output)).toThrow(
    "pointer replacement failed"
  );
  expect(realpathSync(output)).toBe(previous);
  expect(readFileSync(join(output, "manifest.json"), "utf8")).toBe(first);
});
