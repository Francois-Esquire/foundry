import nodePath, { posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dirname as nativeDirname,
  isAbsolute as nativeIsAbsolute,
  join as nativeJoin,
  normalize as nativeNormalize,
  relative as nativeRelative,
  resolve as nativeResolve,
  sep as nativeSep,
} from "../../src/lib/path-native";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "../../src/lib/path-posix";

const SEGMENTS = [
  "",
  ".",
  "..",
  "/",
  "//",
  "/a/b/",
  "/a//b",
  "/a/./b/../c",
  "a/b",
  "../a",
  "./a/",
  "/a/b/c.ts",
  "/root/packages/ünïcode/src/日本.ts",
  "/root/dir with space/a b.ts",
  "/root/back\\slash/name",
  "/root/node_modules/@scope/pkg/index.d.ts",
  "/..",
  "/a/b/../../..",
];

const ABSOLUTE = SEGMENTS.filter((segment) => segment.startsWith("/"));

describe("native path operations", () => {
  it("are node:path's own functions", () => {
    expect(nativeDirname).toBe(nodePath.dirname);
    expect(nativeIsAbsolute).toBe(nodePath.isAbsolute);
    expect(nativeJoin).toBe(nodePath.join);
    expect(nativeNormalize).toBe(nodePath.normalize);
    expect(nativeRelative).toBe(nodePath.relative);
    expect(nativeResolve).toBe(nodePath.resolve);
    expect(nativeSep).toBe(nodePath.sep);
  });
});

describe("browser path operations", () => {
  it("use the POSIX separator", () => {
    expect(sep).toBe("/");
  });

  it("match node:path/posix for single paths", () => {
    for (const path of SEGMENTS) {
      expect(dirname(path)).toBe(posix.dirname(path));
      expect(isAbsolute(path)).toBe(posix.isAbsolute(path));
      expect(normalize(path)).toBe(posix.normalize(path));
    }
  });

  it("match node:path/posix for pairs", () => {
    for (const from of SEGMENTS) {
      for (const to of SEGMENTS) {
        expect(join(from, to)).toBe(posix.join(from, to));
      }
    }
    for (const from of ABSOLUTE) {
      for (const to of SEGMENTS) {
        expect(resolve(from, to)).toBe(posix.resolve(from, to));
      }
      for (const to of ABSOLUTE) {
        expect(relative(from, to)).toBe(posix.relative(from, to));
      }
    }
  });

  it("joins any number of segments like node:path/posix", () => {
    expect(join()).toBe(posix.join());
    expect(join("/a", "b", "../c", "./d/")).toBe(
      posix.join("/a", "b", "../c", "./d/")
    );
    expect(resolve("/a", "b", "/c", "d")).toBe(
      posix.resolve("/a", "b", "/c", "d")
    );
  });
});
