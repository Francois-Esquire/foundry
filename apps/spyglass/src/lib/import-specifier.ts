import { posix } from "node:path";
import type { SourceFile } from "ts-morph";

// The specifier an importer would write to reach a module: the planner names
// it, and the mutator writes it. One function, so the two never disagree.

type SpecifierStyle = "extensionless" | "js" | "ts";

const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;
const JS_EXTENSION = /\.[cm]?jsx?$/;
const TS_EXTENSION = /\.[cm]?tsx?$/;
/** Module formats whose resolution never drops the extension. */
const EXPLICIT_FORMAT = /\.[cm][jt]s$/;

/** `.ts` and `.tsx` are written `.js`, `.mts` `.mjs`, `.cts` `.cjs`; JavaScript keeps its own. */
const JS_FOR: Record<string, string> = {
  ".cjs": ".cjs",
  ".cts": ".cjs",
  ".js": ".js",
  ".jsx": ".jsx",
  ".mjs": ".mjs",
  ".mts": ".mjs",
  ".ts": ".js",
  ".tsx": ".js",
};

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function styleOf(specifier: string): SpecifierStyle {
  if (TS_EXTENSION.test(specifier)) {
    return "ts";
  }
  if (JS_EXTENSION.test(specifier)) {
    return "js";
  }
  return "extensionless";
}

/** The importer's own relative-specifier style by majority; a tie goes extensionless, then `.js`. */
function importerStyle(importer: SourceFile): SpecifierStyle | undefined {
  const counts: Record<SpecifierStyle, number> = {
    extensionless: 0,
    js: 0,
    ts: 0,
  };
  const declarations = [
    ...importer.getImportDeclarations(),
    ...importer.getExportDeclarations(),
  ];
  for (const declaration of declarations) {
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier !== undefined && isRelative(specifier)) {
      counts[styleOf(specifier)] += 1;
    }
  }
  const order: SpecifierStyle[] = ["extensionless", "js", "ts"];
  const most = Math.max(...order.map((style) => counts[style]));
  if (most === 0) {
    return undefined;
  }
  return order.find((style) => counts[style] === most);
}

/** An existing import or re-export of `importer` that already reaches `target`, as written. */
function existingSpecifier(
  importer: SourceFile,
  target: SourceFile
): string | undefined {
  const declarations = [
    ...importer.getImportDeclarations(),
    ...importer.getExportDeclarations(),
  ];
  for (const declaration of declarations) {
    if (declaration.getModuleSpecifierSourceFile() === target) {
      const specifier = declaration.getModuleSpecifierValue();
      if (specifier !== undefined) {
        return specifier;
      }
    }
  }
  return undefined;
}

function written(target: string, style: SpecifierStyle): string {
  const extension = posix.extname(target);
  const stem = target.slice(0, target.length - extension.length);
  if (style === "ts") {
    return target;
  }
  if (style === "js" || EXPLICIT_FORMAT.test(target)) {
    return `${stem}${JS_FOR[extension] ?? extension}`;
  }
  return stem;
}

/**
 * The specifier `importer` should use to import from `target`: the one it
 * already uses for that module, if any; otherwise a relative path in the
 * importer's own style (extensionless, `.js`, or the source's `.ts`), else
 * in `hint`'s (a specifier written elsewhere for the same move, such as the
 * entrypoint's re-export), else extensionless. `/index` is never dropped.
 */
export function importSpecifierFor(
  importer: SourceFile,
  target: SourceFile,
  hint?: string
): string {
  const existing = existingSpecifier(importer, target);
  if (existing !== undefined) {
    return existing;
  }
  const hinted =
    hint !== undefined && isRelative(hint) ? styleOf(hint) : undefined;
  const style = importerStyle(importer) ?? hinted ?? "extensionless";
  const from = posix.dirname(importer.getFilePath());
  const to = target.getFilePath();
  const path = SOURCE_EXTENSION.test(to)
    ? written(posix.relative(from, to), style)
    : posix.relative(from, to);
  return path.startsWith("../") ? path : `./${path}`;
}
