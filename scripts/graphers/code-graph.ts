// Code Graph Grapher
// This module will build a code graph of import/export relationships in the codebase.
// It should be able to:
// - Parse all source files for import/export statements
// - Build a directed graph of file/module dependencies
// - Optionally visualize or output the graph in a standard format (e.g., DOT, JSON)
// - Detect cycles, dead code, and other structural issues
//
// Future: Integrate with dependency graph for holistic analysis

import { promises as fs } from "fs";
import path from "path";

import type { Logger } from "../detectors/types";

const IMPORT_EXPORT_REGEX =
  /(?:import\s+[^'"`]*from\s+['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)|export\s+\*\s+from\s+['"]([^'"]+)['"])/g;

async function getAllTsFiles(dir: string, rootDir: string): Promise<string[]> {
  let files: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(await getAllTsFiles(fullPath, rootDir));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(path.relative(rootDir, fullPath));
    }
  }
  return files;
}

export async function buildCodeGraph(rootDir: string, logger: Logger) {
  const srcDir = path.join(rootDir, "src");
  let nodes: string[] = [];
  let edges: { from: string; to: string }[] = [];
  const warnings: string[] = [];

  let files: string[] = [];
  try {
    files = await getAllTsFiles(srcDir, rootDir);
    nodes = files;
  } catch (err) {
    logger.error("Failed to scan source files for code graph.", err);
    warnings.push("Failed to scan source files for code graph.");
    return { nodes: [], edges: [], warnings };
  }

  for (const relFile of files) {
    const absFile = path.join(rootDir, relFile);
    let content: string;
    try {
      content = await fs.readFile(absFile, "utf8");
    } catch (err) {
      logger.warn(`Could not read file: ${relFile}`);
      warnings.push(`Could not read file: ${relFile}`);
      continue;
    }
    let match: RegExpExecArray | null;
    IMPORT_EXPORT_REGEX.lastIndex = 0;
    while ((match = IMPORT_EXPORT_REGEX.exec(content))) {
      const importPath = match[1] || match[2] || match[3];
      if (!importPath) continue;
      // Only consider relative imports within the project
      if (importPath.startsWith(".")) {
        // Resolve the imported file to a project-relative path
        let importedFile = path.relative(
          rootDir,
          path.resolve(path.dirname(absFile), importPath),
        );
        // Try to resolve to a .ts file if not present
        if (!importedFile.endsWith(".ts")) {
          if (files.includes(importedFile + ".ts")) {
            importedFile = importedFile + ".ts";
          } else if (files.includes(path.join(importedFile, "index.ts"))) {
            importedFile = path.join(importedFile, "index.ts");
          }
        }
        if (files.includes(importedFile)) {
          edges.push({ from: relFile, to: importedFile });
        } else {
          warnings.push(
            `Unresolved import in ${relFile}: ${importPath} (resolved as ${importedFile})`,
          );
        }
      }
    }
  }

  return { nodes, edges, warnings };
}
