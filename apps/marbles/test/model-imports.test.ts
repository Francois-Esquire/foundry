import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { TERMINAL_RUN_STATUSES } from "~/lib/run-store";
import { isTerminal } from "~/model/run-status";

const model = fileURLToPath(new URL("../src/model/", import.meta.url));
const SOURCE_FILE = /\.tsx?$/;

function typeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    const clause = node.exportClause;
    return (
      node.isTypeOnly ||
      (clause !== undefined &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((element) => element.isTypeOnly))
    );
  }
  const clause = node.importClause;
  if (clause === undefined) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

it("imports only types from lib/ and nothing else from Marbles in src/model/", async () => {
  const entries = await readdir(model, { recursive: true });
  const refused: string[] = [];
  for (const entry of entries.filter((name) => SOURCE_FILE.test(name))) {
    const text = await readFile(join(model, entry), "utf8");
    const file = ts.createSourceFile(entry, text, ts.ScriptTarget.Latest);
    for (const statement of file.statements) {
      if (
        !(
          (ts.isImportDeclaration(statement) ||
            ts.isExportDeclaration(statement)) &&
          statement.moduleSpecifier !== undefined &&
          ts.isStringLiteral(statement.moduleSpecifier)
        )
      ) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      const marbles = specifier.startsWith("~/") || specifier.startsWith(".");
      const fromModel =
        specifier.startsWith("~/model/") || specifier.startsWith("./");
      if (
        marbles &&
        !fromModel &&
        !(specifier.startsWith("~/lib/") && typeOnly(statement))
      ) {
        refused.push(`${entry}: ${specifier}`);
      }
    }
  }
  expect(refused).toEqual([]);
});

it("tells a terminal run status as lib/ does", () => {
  for (const status of [
    "queued",
    "running",
    "complete",
    "failed",
    "cancelled",
    "suspended",
    "paused",
    "skipped",
  ]) {
    expect(isTerminal(status)).toBe(TERMINAL_RUN_STATUSES.has(status));
  }
});
