import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT =
  /(?:import|export)[^"']*?from\s+["']([^"']+)["']|import\(["']([^"']+)["']\)/g;
const NODE_GLOBALS =
  /\b(?:process|Buffer|Bun|__dirname|__filename|setImmediate)\b/;

function graph(entry: string): {
  files: string[];
  packages: Set<string>;
  sources: Map<string, string>;
} {
  const files: string[] = [];
  const packages = new Set<string>();
  const sources = new Map<string, string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.includes(file)) {
      continue;
    }
    files.push(file);
    const raw = readFileSync(file, "utf8");
    sources.set(relative(SRC, file), raw);
    const source = raw.replace(/import type[^;]*;/g, "");
    for (const match of source.matchAll(IMPORT)) {
      const target = match[1] ?? match[2] ?? "";
      if (!target.startsWith(".")) {
        packages.add(target);
        continue;
      }
      const base = resolve(dirname(file), target);
      const found = [`${base}.ts`, join(base, "index.ts")].find(existsSync);
      if (found) {
        pending.push(found);
      }
    }
  }
  return {
    files: files.map((file) => relative(SRC, file)),
    packages,
    sources,
  };
}

for (const [label, entry, expectedFile] of [
  ["base entry", "index.ts", "artifacts.ts"],
  ["memory store entry", "store/memory.ts", "store/memory.ts"],
] as const) {
  it(`loads no node:* imports, ./node adapters, or Node globals from the ${label}`, () => {
    const { files, packages, sources } = graph(join(SRC, entry));
    expect(files.filter((file) => file.startsWith("node/"))).toEqual([]);
    expect([...packages].filter((name) => name.startsWith("node:"))).toEqual(
      []
    );
    expect(files).toContain(expectedFile);
    for (const [file, source] of sources) {
      expect(source, `${file} should not reference Node globals`).not.toMatch(
        NODE_GLOBALS
      );
    }
  });
}
