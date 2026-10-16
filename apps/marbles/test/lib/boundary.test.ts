import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preProcessFile } from "typescript";
import { expect, it } from "vitest";

it("engine imports remain inside lib or use external packages", async () => {
  const root = fileURLToPath(new URL("../../src/lib/", import.meta.url));
  const violations: string[] = [];
  const files = await readdir(root, { recursive: true });
  for (const file of files.filter((name) => name.endsWith(".ts"))) {
    const path = resolve(root, file);
    const source = await readFile(path, "utf8");
    for (const imported of preProcessFile(source, true, true).importedFiles) {
      const specifier = imported.fileName;
      let target: string | undefined;
      if (specifier.startsWith("~/")) {
        target = resolve(root, "..", specifier.slice(2));
      } else if (specifier.startsWith(".")) {
        target = resolve(dirname(path), specifier);
      }
      if (target === undefined) {
        continue;
      }
      const outside = relative(root, target);
      if (outside.startsWith("..") || isAbsolute(outside)) {
        violations.push(`${file}: ${specifier}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
