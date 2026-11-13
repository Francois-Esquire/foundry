import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT =
  /(?:import|export)[^"']*?from\s+["']([^"']+)["']|import\(["']([^"']+)["']\)/g;
const ON_DEVICE = ["@huggingface/transformers", "@browser-ai/transformers-js"];

/** Every module the base entry reaches, and the packages they import. */
function graph(entry: string): { files: string[]; packages: Set<string> } {
  const files: string[] = [];
  const packages = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.includes(file)) {
      continue;
    }
    files.push(file);
    const source = readFileSync(file, "utf8").replace(/import type[^;]*;/g, "");
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
  return { files: files.map((file) => relative(SRC, file)), packages };
}

it("loads no on-device runtime, worker, or transformers from the base entry", () => {
  const { files, packages } = graph(join(SRC, "index.ts"));
  expect(files.filter((file) => file.startsWith("local/"))).toEqual([]);
  expect(ON_DEVICE.filter((name) => packages.has(name))).toEqual([]);
  expect(files).toContain("manager.ts");
});
