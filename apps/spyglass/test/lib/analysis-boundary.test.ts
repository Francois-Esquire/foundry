import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("keeps mutation handlers outside the runtime dependencies of analysis", () => {
  const root = resolve(import.meta.dirname, "../../src/lib");
  const seen = new Set<string>();
  const pending = [join(root, "analyze.ts")];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const parsed = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    for (const statement of parsed.statements) {
      if (
        !(
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier)
        )
      ) {
        continue;
      }
      const clause = statement.importClause;
      if (clause?.isTypeOnly) {
        continue;
      }
      const bindings = clause?.namedBindings;
      if (
        !clause?.name &&
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.every((binding) => binding.isTypeOnly)
      ) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith(".")) {
        pending.push(resolve(dirname(file), `${specifier}.ts`));
      }
    }
  }
  for (const name of [
    "apply.ts",
    "apply-imports.ts",
    "internalize-edits.ts",
    "operators.ts",
    "codemod-apply.ts",
  ]) {
    expect(seen.has(join(root, name)), name).toBe(false);
  }
});
