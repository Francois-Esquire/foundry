import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ModelsEventEmitter } from "../models";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT =
  /(?:import|export)[^"']*?from\s+["']([^"']+)["']|import\(["']([^"']+)["']\)/g;
const ON_DEVICE = ["@huggingface/transformers", "@browser-ai/transformers-js"];

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

it("loads no on-device runtime, worker, transformers, or node:* imports from the base entry", () => {
  const { files, packages } = graph(join(SRC, "index.ts"));
  expect(files.filter((file) => file.startsWith("local/"))).toEqual([]);
  expect(ON_DEVICE.filter((name) => packages.has(name))).toEqual([]);
  expect([...packages].filter((name) => name.startsWith("node:"))).toEqual([]);
  expect(files).toContain("models.ts");
});

it("preserves EventEmitter semantics on ModelsEventEmitter", () => {
  const emitter = new ModelsEventEmitter();
  const seen: string[] = [];
  let receiver: unknown;

  const repeated = function (this: unknown, value: string) {
    receiver = this;
    seen.push(`on:${value}`);
  };
  emitter.addListener("tick", repeated).on("tick", repeated);
  expect(emitter.listenerCount("tick")).toBe(2);

  let nestedCalls = 0;
  emitter.once("tick", () => {
    nestedCalls += 1;
    if (nestedCalls === 1) {
      emitter.emit("tick", "nested");
    }
  });
  expect(emitter.listenerCount("tick")).toBe(3);

  expect(emitter.emit("tick", "first")).toBe(true);
  expect(receiver).toBe(emitter);
  expect(nestedCalls).toBe(1);
  expect(emitter.listenerCount("tick")).toBe(2);

  emitter.removeListener("tick", repeated);
  expect(emitter.listenerCount("tick")).toBe(1);
  emitter.off("tick", repeated);
  expect(emitter.listenerCount("tick")).toBe(0);
  expect(emitter.emit("tick", "none")).toBe(false);

  emitter.on("a", () => undefined).on("b", () => undefined);
  emitter.removeAllListeners("a");
  expect(emitter.listenerCount("a")).toBe(0);
  expect(emitter.listenerCount("b")).toBe(1);
  emitter.removeAllListeners();
  expect(emitter.listenerCount("b")).toBe(0);

  const boom = new Error("unhandled");
  expect(() => emitter.emit("error", boom)).toThrow(boom);
});
