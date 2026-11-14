import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import extractTsConfig from "dependency-cruiser/config-utl/extract-ts-config";
import {
  expandPattern,
  ownerBoundary,
  workspacePathAliases,
  workspacePatterns,
} from "./boundary";
import type { Boundary } from "./boundary-model";
import { toPosix } from "./boundary-model";
import { createIgnorer } from "./ignore";
import { cruiseEntries } from "./module-cruise";
import type { CrossBoundaryEdges, CruisedModule } from "./module-graph";
import { normalizeEdges } from "./module-graph";

function synthesizeTsconfig(root: string): {
  file: string;
  compilerOptions: { baseUrl: string; paths: Record<string, string[]> };
} {
  const paths: Record<string, string[]> = {};
  for (const [key, targets] of Object.entries(workspacePathAliases(root))) {
    paths[key] = targets.map((target) => toPosix(relative(root, target)));
  }
  const compilerOptions = { baseUrl: toPosix(root), paths };
  const dir = mkdtempSync(join(tmpdir(), "semantic-surface-"));
  const file = join(dir, "tsconfig.json");
  writeFileSync(file, JSON.stringify({ compilerOptions }));
  return { compilerOptions, file };
}

export async function collectCrossBoundaryEdges(
  root: string,
  boundary: Boundary,
  tsconfig?: string
): Promise<CrossBoundaryEdges> {
  const modules = await cruiseWorkspace(root, tsconfig);
  return normalizeEdges(root, boundary, modules, {
    ignores: createIgnorer(root).ignores,
    ownerOf: (filePath) => ownerBoundary(root, filePath),
  });
}

export async function cruiseWorkspace(
  root: string,
  tsconfig?: string | undefined
): Promise<CruisedModule[]> {
  const synthesized = tsconfig ? undefined : synthesizeTsconfig(root);
  const tsconfigFile = synthesized?.file ?? resolve(root, tsconfig ?? "");
  const transpileTsConfig: unknown = synthesized
    ? { options: synthesized.compilerOptions }
    : extractTsConfig(tsconfigFile);
  const patterns = workspacePatterns(root);
  const entries = (patterns.length > 0 ? patterns : [""]).flatMap((pattern) =>
    pattern === ""
      ? ["."]
      : expandPattern(root, pattern).map((dir) => toPosix(relative(root, dir)))
  );
  try {
    return await cruiseEntries(
      root,
      entries.filter((entry) => existsSync(resolve(root, entry))),
      tsconfigFile,
      transpileTsConfig
    );
  } finally {
    if (synthesized) {
      rmSync(dirname(synthesized.file), { recursive: true });
    }
  }
}
