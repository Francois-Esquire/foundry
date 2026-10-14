import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import type { Project, SourceFile } from "ts-morph";

import { Node } from "ts-morph";

import type { Boundary, BoundaryEntrypoint } from "./boundary";
import {
  boundaryEntrypoints,
  expandPattern,
  ownerBoundary,
  resolveBoundary,
  toPosix,
  workspacePatterns,
} from "./boundary";
import { createProject } from "./project";
import { kindOf, topLevelDeclarations } from "./symbols";
import type { SymbolKind } from "./types";

// V11.3 planning context: one TypeScript project over the workspace plus
// the package manifests and entrypoints, read once. Everything here reads;
// the project is shared by every plan, so nothing may manipulate its AST.

export interface OperatorPlanningPackage {
  boundary: Boundary;
  /** Declared dependencies, dev and peer included, sorted. */
  dependencies: string[];
  /** Absolute directory. */
  dir: string;
  entrypoints: BoundaryEntrypoint[];
  id: string;
  /** Root-relative manifest. */
  manifest: string;
  /** Root-relative directory. */
  relPath: string;
  /** Root-relative source directory the entrypoints sit under, when they share one. */
  sourceDir?: string;
}

export interface OperatorPlanningContext {
  /** Root-relative file → package id, for files the project parsed. */
  moduleIndex: Map<string, string>;
  packages: Map<string, OperatorPlanningPackage>;
  project: Project;
  root: string;
}

export interface OperatorPlanningContextOptions {
  /** Package ids to index; every workspace package by default. */
  packages?: string[];
  root: string;
  tsconfig?: string;
}

export interface LocatedSymbol {
  /** Exported from its own module. */
  exported: boolean;
  /** Root-relative file. */
  file: string;
  id: string;
  kind: SymbolKind;
  name: string;
  node: Node;
  package?: string;
  sourceFile: SourceFile;
}

export type SymbolLocation =
  | { status: "located"; symbol: LocatedSymbol }
  | { status: "missing"; detail: string }
  | { status: "ambiguous"; detail: string; kinds: SymbolKind[] };

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  peerDependencies?: Record<string, string>;
}

function readManifest(dir: string): Manifest | undefined {
  const file = join(dir, "package.json");
  if (!existsSync(file)) {
    return undefined;
  }
  return JSON.parse(readFileSync(file, "utf8")) as Manifest;
}

function packageDirs(root: string): string[] {
  return workspacePatterns(root).flatMap((pattern) =>
    expandPattern(root, pattern)
  );
}

function sharedSourceDir(
  entrypoints: BoundaryEntrypoint[]
): string | undefined {
  const dirs = new Set(entrypoints.map((e) => posix.dirname(e.file)));
  if (dirs.size !== 1) {
    return undefined;
  }
  const [dir] = dirs;
  return dir;
}

export function createOperatorPlanningContext(
  options: OperatorPlanningContextOptions
): OperatorPlanningContext {
  const root = realpathSync(resolve(options.root));
  const project = createProject(root, options.tsconfig);
  const packages = new Map<string, OperatorPlanningPackage>();
  const wanted =
    options.packages === undefined ? undefined : new Set(options.packages);
  for (const dir of packageDirs(root)) {
    const manifest = readManifest(dir);
    const id = manifest?.name;
    if (manifest === undefined || id === undefined) {
      continue;
    }
    if (wanted !== undefined && !wanted.has(id)) {
      continue;
    }
    const real = realpathSync(dir);
    const relPath = toPosix(relative(root, real));
    const boundary = resolveBoundary(root, relPath);
    const entrypoints = boundaryEntrypoints(boundary);
    packages.set(id, {
      boundary,
      dependencies: [
        ...new Set([
          ...Object.keys(manifest.dependencies ?? {}),
          ...Object.keys(manifest.devDependencies ?? {}),
          ...Object.keys(manifest.peerDependencies ?? {}),
        ]),
      ].sort((a, b) => a.localeCompare(b)),
      dir: real,
      entrypoints,
      id,
      manifest: `${relPath}/package.json`,
      relPath,
      ...(sharedSourceDir(entrypoints) !== undefined && {
        sourceDir: sharedSourceDir(entrypoints),
      }),
    });
  }
  const moduleIndex = new Map<string, string>();
  for (const file of project.getSourceFiles()) {
    if (file.isDeclarationFile() || file.isInNodeModules()) {
      continue;
    }
    const owner = ownerBoundary(root, file.getFilePath());
    if (packages.has(owner)) {
      moduleIndex.set(toPosix(relative(root, file.getFilePath())), owner);
    }
  }
  return { moduleIndex, packages, project, root };
}

export function relativeFile(
  context: OperatorPlanningContext,
  file: SourceFile
): string {
  return toPosix(relative(context.root, file.getFilePath()));
}

export function sourceFileOf(
  context: OperatorPlanningContext,
  file: string
): SourceFile | undefined {
  return context.project.getSourceFile(resolve(context.root, file));
}

/** Resolve a `<file>#<Name>` id to its single top-level declaration. Overloads count once; kinds that merge do not. */
export function locateSymbol(
  context: OperatorPlanningContext,
  id: string
): SymbolLocation {
  const hash = id.lastIndexOf("#");
  if (hash <= 0) {
    return { detail: `${id} is not a <file>#<Name> id`, status: "missing" };
  }
  const file = id.slice(0, hash);
  const name = id.slice(hash + 1);
  const sourceFile = sourceFileOf(context, file);
  if (sourceFile === undefined) {
    return { detail: `${file} is not in the project`, status: "missing" };
  }
  const matches = topLevelDeclarations(sourceFile).filter(
    (candidateNode) =>
      Node.hasName(candidateNode) && candidateNode.getName() === name
  );
  const kinds = [...new Set(matches.map(kindOf))].sort((a, b) =>
    a.localeCompare(b)
  );
  if (matches.length === 0) {
    return { detail: `${name} is not declared in ${file}`, status: "missing" };
  }
  if (kinds.length > 1) {
    return {
      detail: `${name} is declared ${kinds.length} times in ${file} (${kinds.join(", ")})`,
      kinds,
      status: "ambiguous",
    };
  }
  const [node] = matches;
  if (node === undefined) {
    return { detail: `${name} is not declared in ${file}`, status: "missing" };
  }
  return {
    status: "located",
    symbol: {
      file,
      id,
      kind: kinds[0] ?? "other",
      name,
      ...(context.moduleIndex.has(file) && {
        package: context.moduleIndex.get(file),
      }),
      exported: isExported(sourceFile, node),
      node,
      sourceFile,
    },
  };
}

const exportedNodesCache = new WeakMap<SourceFile, Map<Node, string[]>>();

/** Names a module exports a declaration under; empty when module-local. */
export function exportedNamesOf(file: SourceFile, node: Node): string[] {
  let names = exportedNodesCache.get(file);
  if (names === undefined) {
    names = new Map<Node, string[]>();
    for (const [name, declarations] of file.getExportedDeclarations()) {
      for (const declaration of declarations) {
        const list = names.get(declaration) ?? [];
        list.push(name);
        names.set(declaration, list);
      }
    }
    for (const list of names.values()) {
      list.sort((a, b) => a.localeCompare(b));
    }
    exportedNodesCache.set(file, names);
  }
  return names.get(node) ?? [];
}

function isExported(file: SourceFile, node: Node): boolean {
  return exportedNamesOf(file, node).length > 0;
}

export function packageOfFile(
  context: OperatorPlanningContext,
  file: string
): string | undefined {
  return context.moduleIndex.get(file);
}

/** sha256 of the file bytes as they are on disk now; `missing` when absent. */
export function hashFile(
  context: OperatorPlanningContext,
  file: string
): string {
  const absolute = resolve(context.root, file);
  if (!existsSync(absolute)) {
    return "missing";
  }
  return createHash("sha256").update(readFileSync(absolute)).digest("hex");
}
