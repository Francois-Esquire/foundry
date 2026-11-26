import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { packageDirectories, readManifest } from "./manifest";

const PERMITTED_CONDITIONAL_TARGETS: Readonly<Record<string, string>> = {
  "@foundry/lib ./async-scope bun": "./src/node/async-scope.ts",
  "@foundry/lib ./async-scope node": "./src/node/async-scope.ts",
};

interface ConditionalTarget {
  readonly condition: string;
  readonly target: string;
}

function runtimeTargets(value: unknown, condition = ""): ConditionalTarget[] {
  if (typeof value === "string") {
    return [{ condition, target: value }];
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value)
    .filter(([key]) => key !== "types")
    .flatMap(([key, nested]) =>
      runtimeTargets(nested, condition ? `${condition}.${key}` : key)
    );
}

function mirroredTargets(subpath: string): string[] {
  return subpath === "."
    ? ["./src/index.ts"]
    : [`./src/${subpath.slice(2)}.ts`, `./src/${subpath.slice(2)}/index.ts`];
}

function auditExport(
  dir: string,
  label: string,
  subpath: string,
  value: unknown
): string[] {
  const targets = runtimeTargets(value);
  if (targets.length === 0) {
    return [`${label}: export "${subpath}" has no source target`];
  }
  const violations = new Set<string>();
  for (const { condition, target } of targets) {
    const permitted =
      PERMITTED_CONDITIONAL_TARGETS[`${label} ${subpath} ${condition}`];
    const expected = permitted ? [permitted] : mirroredTargets(subpath);
    if (!expected.includes(target)) {
      violations.add(
        `${label}: export "${subpath}" targets "${target}", expected ${expected.join(" or ")}`
      );
    }
    if (!existsSync(resolve(dir, target))) {
      violations.add(
        `${label}: export "${subpath}" targets missing file "${target}"`
      );
    }
  }
  return [...violations];
}

export function auditExportLayout(packagesDir: string): string[] {
  const root = resolve(packagesDir);
  const violations: string[] = [];
  for (const dir of packageDirectories(root)) {
    const manifest = readManifest(dir);
    const label = manifest.name ?? relative(root, dir);
    for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
      if (subpath.includes("*")) {
        violations.push(`${label}: wildcard export "${subpath}"`);
      } else {
        violations.push(...auditExport(dir, label, subpath, value));
      }
    }
  }
  return violations;
}

export function assertExportLayout(packagesDir: string): void {
  const violations = auditExportLayout(packagesDir);
  if (violations.length > 0) {
    throw new Error(`Export layout violations:\n- ${violations.join("\n- ")}`);
  }
}
