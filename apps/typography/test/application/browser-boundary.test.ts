/**
 * Nothing the browser loads may reach the Node composition. This follows
 * every import from the app's entry point and checks none of them is a
 * module that needs Node.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(import.meta.dirname, "../../src");
const IMPORT = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const ENDINGS = ["", ".ts", ".tsx", "/index.ts"];

/** Modules that need Node, and the packages only they may import. */
const NODE_ONLY = [
  "src/application/node.ts",
  "src/generation/node-image-codec.ts",
  "src/packaging/engine/node.ts",
];
const NODE_PACKAGES = ["@foundry/artifacts/node", "fast-png", "jpeg-js"];

const fileFor = (from: string, specifier: string): string | undefined => {
  let base: string | undefined;
  if (specifier.startsWith("~/")) {
    base = path.join(SRC, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.join(path.dirname(from), specifier);
  }
  if (base === undefined) {
    return;
  }
  const clean = base.split("?")[0] ?? base;
  return ENDINGS.map((ending) => `${clean}${ending}`).find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile()
  );
};

/** Every module reachable from a file, and every package named on the way. */
const reach = (entry: string) => {
  const files = new Set<string>();
  const packages = new Set<string>();
  const waiting = [entry];
  for (let file = waiting.pop(); file; file = waiting.pop()) {
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    if (!(file.endsWith(".ts") || file.endsWith(".tsx"))) {
      continue;
    }
    for (const [, specifier = ""] of readFileSync(file, "utf8").matchAll(
      IMPORT
    )) {
      const next = fileFor(file, specifier);
      if (next) {
        waiting.push(next);
      } else if (!(specifier.startsWith(".") || specifier.startsWith("~/"))) {
        packages.add(specifier);
      }
    }
  }
  return { files, packages };
};

const relative = (files: ReadonlySet<string>) =>
  [...files].map((file) => `src/${path.relative(SRC, file)}`);

describe("what the browser loads", () => {
  it("never reaches a module that needs Node", () => {
    const { files, packages } = reach(path.join(SRC, "main.tsx"));
    expect(files.size).toBeGreaterThan(200);
    expect(relative(files).filter((file) => NODE_ONLY.includes(file))).toEqual(
      []
    );
    expect(NODE_PACKAGES.filter((name) => packages.has(name))).toEqual([]);
    expect([...packages].filter((name) => name.startsWith("node:"))).toEqual(
      []
    );
  });

  it("can take the application interface without the Node composition", () => {
    const { files, packages } = reach(
      path.join(SRC, "application/application.ts")
    );
    expect(relative(files).filter((file) => NODE_ONLY.includes(file))).toEqual(
      []
    );
    expect(NODE_PACKAGES.filter((name) => packages.has(name))).toEqual([]);
    expect([...packages].filter((name) => name.startsWith("node:"))).toEqual(
      []
    );
    expect(packages.has("@foundry/artifacts")).toBe(true);
  });

  it("is checked by a walk that does see the Node modules", () => {
    const { files, packages } = reach(path.join(SRC, "application/node.ts"));
    expect(relative(files)).toEqual(expect.arrayContaining(NODE_ONLY));
    expect(packages.has("@foundry/artifacts/node")).toBe(true);
  });
});
