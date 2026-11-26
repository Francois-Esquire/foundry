import { existsSync, readdirSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { readManifest, resolveExportTarget } from "./manifest";
import { parseSourceFile, scanSource } from "./scan";

const JS_EXT_PATTERN = /\.(?:mjs|cjs|js)$/;
const BUN_SPECIFIER_PATTERN = /^bun(?::|$)/;

function isOptInSubpath(subpath: string): boolean {
  if (subpath === "./testing/store") {
    return false;
  }
  return ["./node", "./providers", "./testing"].some(
    (root) => subpath === root || subpath.startsWith(`${root}/`)
  );
}

export function portableSubpaths(packageDir: string): string[] {
  const { exports = {} } = readManifest(resolve(packageDir));
  return Object.keys(exports).filter((subpath) => !isOptInSubpath(subpath));
}

function workspacePackages(startDir: string): Map<string, string> {
  const packages = new Map<string, string>();
  let dir = resolve(startDir);
  for (;;) {
    const packagesDir = join(dir, "packages");
    if (existsSync(packagesDir)) {
      loadWorkspacePackages(packagesDir, packages);
      return packages;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return packages;
    }
    dir = parent;
  }
}

function loadWorkspacePackages(
  packagesDir: string,
  out: Map<string, string>
): void {
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pkgDir = join(packagesDir, entry.name);
    if (!existsSync(join(pkgDir, "package.json"))) {
      continue;
    }
    const { name } = readManifest(pkgDir);
    if (name?.startsWith("@foundry/")) {
      out.set(name, pkgDir);
    }
  }
}

function optInTargets(packageDirs: Iterable<string>): Set<string> {
  const optIn = new Set<string>();
  const portable = new Set<string>();
  for (const dir of packageDirs) {
    for (const [subpath, target] of Object.entries(
      readManifest(dir).exports ?? {}
    )) {
      const resolved = resolveExportTarget(target);
      if (resolved !== undefined) {
        (isOptInSubpath(subpath) ? optIn : portable).add(
          resolve(dir, resolved)
        );
      }
    }
  }
  return new Set([...optIn].filter((file) => !portable.has(file)));
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const stem = base.replace(JS_EXT_PATTERN, "");
  for (const candidate of [
    base,
    `${stem}.ts`,
    `${stem}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (
      existsSync(candidate) &&
      (candidate.endsWith(".ts") || candidate.endsWith(".tsx"))
    ) {
      return candidate;
    }
  }
  return null;
}

interface Graph {
  readonly optIn: ReadonlySet<string>;
  readonly workspace: ReadonlyMap<string, string>;
}

type Inspection = { readonly next: string | null } | { readonly error: string };

function inspectRelative(
  file: string,
  specifier: string,
  { optIn }: Graph
): Inspection {
  const resolved = resolveRelative(file, specifier);
  if (resolved === null) {
    return { error: `unresolved relative import "${specifier}"` };
  }
  return optIn.has(resolved)
    ? { error: `forbidden opt-in subpath import "${specifier}"` }
    : { next: resolved };
}

function splitSpecifier(specifier: string): {
  readonly name: string;
  readonly subpath: string;
} {
  const parts = specifier.split("/");
  const nameLength = specifier.startsWith("@") ? 2 : 1;
  const rest = parts.slice(nameLength).join("/");
  return {
    name: parts.slice(0, nameLength).join("/"),
    subpath: rest.length === 0 ? "." : `./${rest}`,
  };
}

function inspectWorkspace(specifier: string, { workspace }: Graph): Inspection {
  const { name, subpath } = splitSpecifier(specifier);
  const depDir = workspace.get(name);
  const target = depDir
    ? resolveExportTarget(readManifest(depDir).exports?.[subpath])
    : undefined;
  const resolved = depDir && target ? resolve(depDir, target) : undefined;
  return resolved && existsSync(resolved)
    ? { next: resolved }
    : { error: `unresolved workspace import "${specifier}"` };
}

function inspectSpecifier(
  file: string,
  specifier: string,
  graph: Graph
): Inspection {
  if (specifier.startsWith("node:") || isBuiltin(specifier)) {
    return { error: `forbidden Node built-in import "${specifier}"` };
  }
  if (BUN_SPECIFIER_PATTERN.test(specifier)) {
    return { error: `forbidden Bun built-in import "${specifier}"` };
  }
  if (specifier.startsWith(".")) {
    return inspectRelative(file, specifier, graph);
  }
  if (isOptInSubpath(splitSpecifier(specifier).subpath)) {
    return { error: `forbidden opt-in subpath import "${specifier}"` };
  }
  if (specifier.startsWith("@foundry/")) {
    return inspectWorkspace(specifier, graph);
  }
  return { next: null };
}

function collectSeedEntries(
  absDir: string,
  pkgName: string,
  exportsMap: Record<string, unknown>,
  subpaths: readonly string[],
  violations: string[]
): string[] {
  const entries: string[] = [];
  for (const subpath of subpaths) {
    const target = resolveExportTarget(exportsMap[subpath]);
    const entry = target ? resolve(absDir, target) : undefined;
    if (entry && existsSync(entry)) {
      entries.push(entry);
    } else {
      violations.push(
        `${pkgName}/package.json: missing or unresolved export "${subpath}"`
      );
    }
  }
  return entries;
}

export function auditWebStandardExports(
  packageDir: string,
  subpaths: readonly string[]
): string[] {
  const absDir = resolve(packageDir);
  const manifest = readManifest(absDir);
  const violations: string[] = [];
  const pending = collectSeedEntries(
    absDir,
    manifest.name ?? absDir,
    manifest.exports ?? {},
    subpaths,
    violations
  );
  const workspace = workspacePackages(absDir);
  const graph: Graph = {
    optIn: optInTargets([absDir, ...workspace.values()]),
    workspace,
  };
  const visited = new Set<string>();

  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) {
      continue;
    }
    visited.add(file);
    const label = relative(absDir, file).replaceAll("\\", "/");
    const { globals, specifiers } = scanSource(parseSourceFile(file));
    for (const globalName of globals) {
      violations.push(`${label}: unguarded Node/Bun global "${globalName}"`);
    }
    for (const specifier of specifiers) {
      const inspection = inspectSpecifier(file, specifier, graph);
      if ("error" in inspection) {
        violations.push(`${label}: ${inspection.error}`);
      } else if (inspection.next !== null) {
        pending.push(inspection.next);
      }
    }
  }

  return violations;
}

export function assertWebStandardExports(
  packageDir: string,
  subpaths: readonly string[]
): void {
  const violations = auditWebStandardExports(packageDir, subpaths);
  if (violations.length > 0) {
    throw new Error(
      `Web-standard export seam violations:\n- ${violations.join("\n- ")}`
    );
  }
}
