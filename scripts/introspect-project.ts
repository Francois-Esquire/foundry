/**
 * Project Introspection Features (Planned & Implemented):
 *
 * 1. Monorepo/Workspace Detection (implemented)
 *    - Detect workspaces (package.json, lerna.json, turbo.json, nx.json)
 *    - List all detected packages/workspaces
 * 2. Environment/Secrets Management (implemented)
 *    - Detect .env files, dotenv usage, or other env management tools
 *    - Warn if sensitive files are not in .gitignore
 *    - Warn if .env exists but .env.example is missing or out of sync
 * 3. Project Normalization (planned)
 *    - Normalize project by suggesting/creating missing files (e.g., .env.example)
 *    - Refine rough edges (e.g., sync .env and .env.example structure)
 * 4. Test/CI/CD Detection
 *    - Detect test frameworks (Jest, Mocha, Vitest, etc.)
 *    - Detect CI/CD config files (.github/workflows/, .gitlab-ci.yml, circleci/, etc.)
 *    - List test-related scripts
 * 5. Linting/Formatting Tools
 *    - Detect ESLint, Prettier, Stylelint, etc. via dependencies or config files
 *    - List config files found
 * 6. Documentation/Readme
 *    - Check for README.md, CONTRIBUTING.md, etc.
 *    - Optionally extract first heading/description from README.md
 * 7. License and Metadata
 *    - Detect LICENSE file and type
 *    - Extract license field from package.json
 * 8. Build Tools/Config
 *    - Detect build tools (Webpack, Vite, Rollup, Parcel, etc.)
 *    - List config files found
 * 9. Custom/Project-Specific Heuristics
 *    - Detect Dockerfiles, deployment configs, infra-as-code
 *    - Detect usage of specific cloud providers/services
 * 10. Dependency Health
 *    - Optionally check for outdated/deprecated/vulnerable dependencies
 *    - Warn about non-semver or risky packages (e.g., storybook), require manual approval for certain updates
 * 11. TypeScript Strictness
 *    - Parse tsconfig.json and report strictness settings
 * 12. Component System Detection (planned)
 *    - Detect shadCN, Storybook, or other component-driven development libraries
 *    - Detect presence of component systems or design systems
 * 13. Codebase Change Detection (planned)
 *    - Compute hashes for directories/files for robust change tracking
 *    - Plan for efficient change detection without reading all file contents if possible
 * 14. Git Operations (planned)
 *    - Detect if project is a git repo
 *    - Get current commit hash, last checked commit
 *    - Detect changes since last commit, plan for change-based steps
 * 15. Security & Privacy (planned)
 *    - Do not store or expose absolute file paths; only use project-relative paths in results and logs
 *    - Ensure all traversal and engine steps use project-relative paths
 *    - Store project root reference once if needed, but avoid leaking user directory structure
 *    - Scope all context for LLMs to project-local data only
 *    - Consider redacting or anonymizing sensitive file names or patterns
 *    - Review for other privacy/security issues (e.g., secrets in logs, accidental uploads, etc.)
 *    - Review and update all steps for privacy/security best practices as features are implemented
 *
 * (Implemented: File system traversal, project type detection, package.json analysis, monorepo detection, environment management)
 */

import { promises as fs } from "fs";
import path from "path";

import ignore from "ignore";

// =====================
// Types
// =====================

export interface Logger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export type StepResult<T = unknown> = {
  name: string;
  durationMs: number;
  result: T;
  startTime: string;
  endTime: string;
};

export type BaseStep = StepResult;

export type TraverseFileSystemResult = {
  results: string[];
  ignored: string[];
};

export type ProjectTypeResult = {
  type: string;
  details: Record<string, boolean>;
};

export type AnalyzePackageJsonResult = {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  scripts: Record<string, string>;
  engines: Record<string, string>;
  detectedRunner: string;
  lockFiles: string[];
  frameworks: string[];
  typescript: boolean;
  warnings: string[];
};

export type MonorepoDetectionResult = {
  isMonorepo: boolean;
  workspaces: string[];
  tools: string[];
  warnings: string[];
};

export type EnvManagementResult = {
  envFiles: string[];
  dotenvUsed: boolean;
  missingEnvExample: boolean;
  envSyncIssue: boolean;
  warnings: string[];
};

export type ProjectNormalizationResult = {
  normalized: boolean;
  actions: string[];
  warnings: string[];
};

export type IntrospectReport = {
  steps: BaseStep[];
  warnings: string[];
};

// =====================
// Logger
// =====================

export const defaultLogger: Logger = {
  log: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

// =====================
// Logic
// =====================

// Helper to load ignore patterns from .gitignore
async function loadIgnorePatterns(
  rootDir: string,
  logger: Logger = defaultLogger,
): Promise<string[]> {
  try {
    const gitignorePath = path.join(rootDir, ".gitignore");
    const content = await fs.readFile(gitignorePath, "utf8");
    const filtered = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    return filtered;
  } catch (err) {
    // If .gitignore doesn't exist, just ignore
    logger.warn("No .gitignore found at", rootDir);
    return [];
  }
}

// Recursively traverse the file system and collect all paths in a flat array, using the include predicate
async function traverseFileSystem(
  dir: string,
  include: (relPath: string, entry: import("fs").Dirent) => boolean,
  rootDir: string,
  ignoredPaths: string[],
  logger: Logger = defaultLogger,
): Promise<string[]> {
  let results: string[] = [];
  const list = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of list) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath);
    // Always skip the .git directory itself
    if (relPath === ".git" || relPath.startsWith(".git/")) continue;
    // Always ignore node_modules
    if (relPath === "node_modules" || relPath.startsWith("node_modules/")) {
      ignoredPaths.push(relPath);
      continue;
    }
    if (!include(relPath, entry)) {
      ignoredPaths.push(relPath);
      continue;
    }
    results.push(fullPath);
    if (entry.isDirectory()) {
      const subResults = await traverseFileSystem(
        fullPath,
        include,
        rootDir,
        ignoredPaths,
        logger,
      );
      results = results.concat(subResults);
    }
  }
  return results;
}

// Step runner utility
async function runStep<T = unknown>(
  name: string,
  fn: () => Promise<T>,
  logger: Logger = defaultLogger,
): Promise<StepResult<T>> {
  const start = Date.now();
  const startTime = new Date(start).toISOString();
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    logger.error(`Error in step '${name}':`, err);
    throw err;
  }
  const end = Date.now();
  const endTime = new Date(end).toISOString();
  return {
    name,
    durationMs: end - start,
    result,
    startTime,
    endTime,
  };
}

// Project type detection step
async function detectProjectType(
  rootDir: string,
  logger: Logger = defaultLogger,
): Promise<ProjectTypeResult> {
  const files = await fs.readdir(rootDir);
  const details: Record<string, boolean> = {
    hasPackageJson: files.includes("package.json"),
    hasBunConfig: files.includes("bun.lockb") || files.includes("bunfig.toml"),
    hasYarnLock: files.includes("yarn.lock"),
    hasPnpmLock: files.includes("pnpm-lock.yaml"),
    hasNpmLock: files.includes("package-lock.json"),
    hasTsConfig: files.includes("tsconfig.json"),
  };
  let type = "unknown";
  if (details.hasPackageJson) type = "node";
  if (details.hasBunConfig) type = "bun";
  return { type, details };
}

// Analyze package.json and lock files for project requirements and runner
async function analyzePackageJson(
  rootDir: string,
  logger: Logger = defaultLogger,
): Promise<AnalyzePackageJsonResult> {
  const warnings: string[] = [];
  let pkg: unknown = null;
  let pkgPath = path.join(rootDir, "package.json");
  let dependencies: Record<string, string> = {},
    devDependencies: Record<string, string> = {},
    peerDependencies: Record<string, string> = {},
    optionalDependencies: Record<string, string> = {},
    scripts: Record<string, string> = {},
    engines: Record<string, string> = {},
    frameworks: string[] = [];
  let typescript = false;
  let detectedRunner = "unknown";
  let lockFiles: string[] = [];

  // Scan for lock files
  const files = await fs.readdir(rootDir);
  if (files.includes("package-lock.json")) lockFiles.push("package-lock.json");
  if (files.includes("yarn.lock")) lockFiles.push("yarn.lock");
  if (files.includes("pnpm-lock.yaml")) lockFiles.push("pnpm-lock.yaml");
  if (files.includes("bun.lockb")) lockFiles.push("bun.lockb");

  // Detect ambiguity in lock files
  if (lockFiles.length > 1) {
    const msg = `Multiple lock files detected: ${lockFiles.join(", ")}`;
    warnings.push(msg);
    logger.warn(msg);
  }

  // Try to read and parse package.json
  try {
    const pkgRaw = await fs.readFile(pkgPath, "utf8");
    pkg = JSON.parse(pkgRaw);
    // Defensive: Only assign if type is object
    if (typeof pkg === "object" && pkg !== null) {
      const obj = pkg as Record<string, unknown>;
      dependencies =
        typeof obj.dependencies === "object" && obj.dependencies !== null
          ? (obj.dependencies as Record<string, string>)
          : {};
      devDependencies =
        typeof obj.devDependencies === "object" && obj.devDependencies !== null
          ? (obj.devDependencies as Record<string, string>)
          : {};
      peerDependencies =
        typeof obj.peerDependencies === "object" &&
        obj.peerDependencies !== null
          ? (obj.peerDependencies as Record<string, string>)
          : {};
      optionalDependencies =
        typeof obj.optionalDependencies === "object" &&
        obj.optionalDependencies !== null
          ? (obj.optionalDependencies as Record<string, string>)
          : {};
      scripts =
        typeof obj.scripts === "object" && obj.scripts !== null
          ? (obj.scripts as Record<string, string>)
          : {};
      engines =
        typeof obj.engines === "object" && obj.engines !== null
          ? (obj.engines as Record<string, string>)
          : {};
    }
    // Detect frameworks/tools
    const allDeps = { ...dependencies, ...devDependencies };
    if (allDeps["react"]) frameworks.push("react");
    if (allDeps["next"]) frameworks.push("next");
    if (allDeps["express"]) frameworks.push("express");
    if (allDeps["vue"]) frameworks.push("vue");
    if (allDeps["svelte"]) frameworks.push("svelte");
    if (allDeps["@nestjs/core"]) frameworks.push("nestjs");
    if (allDeps["typescript"]) typescript = true;
    if (files.includes("tsconfig.json")) typescript = true;
    // Detect runner
    if (lockFiles.includes("bun.lockb")) detectedRunner = "bun";
    else if (lockFiles.includes("yarn.lock")) detectedRunner = "yarn";
    else if (lockFiles.includes("pnpm-lock.yaml")) detectedRunner = "pnpm";
    else if (lockFiles.includes("package-lock.json")) detectedRunner = "npm";
    // Check for engines field
    if (engines.bun) detectedRunner = "bun";
    else if (engines.yarn) detectedRunner = "yarn";
    else if (engines.pnpm) detectedRunner = "pnpm";
    else if (engines.npm) detectedRunner = "npm";
    // Check scripts for runner usage
    const scriptStr = JSON.stringify(scripts);
    if (/bun /.test(scriptStr)) detectedRunner = "bun";
    else if (/yarn /.test(scriptStr)) detectedRunner = "yarn";
    else if (/pnpm /.test(scriptStr)) detectedRunner = "pnpm";
    else if (/npm /.test(scriptStr)) detectedRunner = "npm";
  } catch (err: any) {
    const msg = "Could not read or parse package.json: " + err.message;
    warnings.push(msg);
    logger.error(msg);
  }

  return {
    dependencies,
    devDependencies,
    peerDependencies,
    optionalDependencies,
    scripts,
    engines,
    detectedRunner,
    lockFiles,
    frameworks,
    typescript,
    warnings,
  };
}

// Monorepo detection step
async function detectMonorepo(
  rootDir: string,
  logger: Logger = defaultLogger,
): Promise<MonorepoDetectionResult> {
  const warnings: string[] = [];
  let isMonorepo = false;
  let workspaces: string[] = [];
  let tools: string[] = [];
  // Check package.json workspaces
  try {
    const pkgPath = path.join(rootDir, "package.json");
    const pkgRaw = await fs.readFile(pkgPath, "utf8");
    const pkg: unknown = JSON.parse(pkgRaw);
    if (pkg && typeof pkg === "object" && "workspaces" in pkg) {
      const ws = (pkg as { workspaces?: unknown }).workspaces;
      isMonorepo = true;
      tools.push("npm/yarn workspaces");
      if (Array.isArray(ws)) {
        workspaces = ws.filter((w): w is string => typeof w === "string");
      } else if (ws && typeof ws === "object" && "packages" in ws) {
        const pkgs = (ws as { packages?: unknown }).packages;
        if (Array.isArray(pkgs)) {
          workspaces = pkgs.filter((w): w is string => typeof w === "string");
        }
      }
    }
  } catch (err) {
    // ignore if no package.json
  }
  // Check for lerna.json
  try {
    const lernaPath = path.join(rootDir, "lerna.json");
    const lernaRaw = await fs.readFile(lernaPath, "utf8");
    const lerna: unknown = JSON.parse(lernaRaw);
    isMonorepo = true;
    tools.push("lerna");
    if (lerna && typeof lerna === "object" && "packages" in lerna) {
      const pkgs = (lerna as { packages?: unknown }).packages;
      if (Array.isArray(pkgs)) {
        workspaces = workspaces.concat(
          pkgs.filter((w): w is string => typeof w === "string"),
        );
      }
    }
  } catch (err) {
    // ignore if no lerna.json
  }
  // Check for turbo.json
  try {
    const turboPath = path.join(rootDir, "turbo.json");
    await fs.access(turboPath);
    isMonorepo = true;
    tools.push("turborepo");
  } catch (err) {
    // ignore if no turbo.json
  }
  // Check for nx.json
  try {
    const nxPath = path.join(rootDir, "nx.json");
    await fs.access(nxPath);
    isMonorepo = true;
    tools.push("nx");
  } catch (err) {
    // ignore if no nx.json
  }
  if (isMonorepo && workspaces.length === 0) {
    warnings.push("Monorepo detected but no workspaces found");
  }
  return { isMonorepo, workspaces, tools, warnings };
}

// Environment management detection step
async function detectEnvManagement(
  rootDir: string,
  logger: Logger = defaultLogger,
): Promise<EnvManagementResult> {
  const warnings: string[] = [];
  let envFiles: string[] = [];
  let dotenvUsed = false;
  let missingEnvExample = false;
  let envSyncIssue = false;
  // Find .env and .env.example
  try {
    const files = await fs.readdir(rootDir);
    envFiles = files.filter((f) => f.startsWith(".env"));
    if (envFiles.includes(".env")) {
      if (!envFiles.includes(".env.example")) {
        missingEnvExample = true;
        warnings.push(".env exists but .env.example is missing");
      } else {
        // Compare keys (not values) between .env and .env.example
        const envContent = await fs.readFile(
          path.join(rootDir, ".env"),
          "utf8",
        );
        const exampleContent = await fs.readFile(
          path.join(rootDir, ".env.example"),
          "utf8",
        );
        const envKeys =
          envContent
            .split("\n")
            .map((l) => l.split("=")[0]?.trim())
            .filter((k): k is string => !!k) || [];
        const exampleKeys =
          exampleContent
            .split("\n")
            .map((l) => l.split("=")[0]?.trim())
            .filter((k): k is string => !!k) || [];
        const missingInExample = envKeys.filter(
          (k) => !exampleKeys.includes(k),
        );
        if (missingInExample.length > 0) {
          envSyncIssue = true;
          warnings.push(
            `.env.example is missing keys: ${missingInExample.join(", ")}`,
          );
        }
      }
    }
  } catch (err) {
    // ignore if no .env files
  }
  // Detect dotenv usage in package.json
  try {
    const pkgPath = path.join(rootDir, "package.json");
    const pkgRaw = await fs.readFile(pkgPath, "utf8");
    const pkg: unknown = JSON.parse(pkgRaw);
    if (
      pkg &&
      typeof pkg === "object" &&
      (("dependencies" in pkg &&
        typeof (pkg as { dependencies?: unknown }).dependencies === "object" &&
        (pkg as { dependencies?: Record<string, unknown> }).dependencies?.[
          "dotenv"
        ]) ||
        ("devDependencies" in pkg &&
          typeof (pkg as { devDependencies?: unknown }).devDependencies ===
            "object" &&
          (pkg as { devDependencies?: Record<string, unknown> })
            .devDependencies?.["dotenv"]))
    ) {
      dotenvUsed = true;
    }
  } catch (err) {
    // ignore if no package.json
  }
  return { envFiles, dotenvUsed, missingEnvExample, envSyncIssue, warnings };
}

// Project normalization step
async function normalizeProject(
  rootDir: string,
  logger: Logger = defaultLogger,
): Promise<ProjectNormalizationResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  let normalized = false;
  // If .env exists but .env.example is missing, suggest creating it
  try {
    const files = await fs.readdir(rootDir);
    if (files.includes(".env") && !files.includes(".env.example")) {
      actions.push("Suggest creating .env.example based on .env");
      warnings.push(".env.example is missing");
      normalized = false;
    } else if (files.includes(".env") && files.includes(".env.example")) {
      // Compare keys (not values)
      const envContent = await fs.readFile(path.join(rootDir, ".env"), "utf8");
      const exampleContent = await fs.readFile(
        path.join(rootDir, ".env.example"),
        "utf8",
      );
      const envKeys =
        envContent
          .split("\n")
          .map((l) => l.split("=")[0]?.trim())
          .filter(Boolean) || [];
      const exampleKeys =
        exampleContent
          .split("\n")
          .map((l) => l.split("=")[0]?.trim())
          .filter(Boolean) || [];
      const missingInExample = envKeys.filter((k) => !exampleKeys.includes(k));
      if (missingInExample.length > 0) {
        actions.push(
          `Suggest adding missing keys to .env.example: ${missingInExample.join(", ")}`,
        );
        warnings.push(
          `.env.example is missing keys: ${missingInExample.join(", ")}`,
        );
        normalized = false;
      } else {
        normalized = true;
      }
    } else {
      normalized = true;
    }
  } catch (err: any) {
    // ignore if no .env files
  }
  return { normalized, actions, warnings };
}

// Introspect function: runs a series of steps and returns a structured report
async function introspect(
  dir: string,
  include: (relPath: string, entry: import("fs").Dirent) => boolean,
  logger: Logger = defaultLogger,
): Promise<IntrospectReport> {
  const ignoredPaths: string[] = [];
  const steps: BaseStep[] = [];

  // Step 1: Traverse file system
  steps.push(
    await runStep<TraverseFileSystemResult>(
      "traverseFileSystem",
      async () => {
        const results = await traverseFileSystem(
          dir,
          include,
          dir,
          ignoredPaths,
          logger,
        );
        return { results, ignored: ignoredPaths };
      },
      logger,
    ),
  );

  // Step 2: Detect project type
  steps.push(
    await runStep<ProjectTypeResult>(
      "detectProjectType",
      async () => {
        return await detectProjectType(dir, logger);
      },
      logger,
    ),
  );

  // Step 3: Analyze package.json and lock files
  steps.push(
    await runStep<AnalyzePackageJsonResult>(
      "analyzePackageJson",
      async () => {
        return await analyzePackageJson(dir, logger);
      },
      logger,
    ),
  );

  // Step 4: Monorepo detection
  steps.push(
    await runStep<MonorepoDetectionResult>(
      "detectMonorepo",
      async () => {
        return await detectMonorepo(dir, logger);
      },
      logger,
    ),
  );

  // Step 5: Environment management detection
  steps.push(
    await runStep<EnvManagementResult>(
      "detectEnvManagement",
      async () => {
        return await detectEnvManagement(dir, logger);
      },
      logger,
    ),
  );

  // Step 6: Project normalization (planned/partial)
  steps.push(
    await runStep<ProjectNormalizationResult>(
      "normalizeProject",
      async () => {
        return await normalizeProject(dir, logger);
      },
      logger,
    ),
  );

  // Add more steps here as needed

  // Collect warnings from all steps
  const warnings = steps.flatMap((step) =>
    step.result && (step.result as any).warnings
      ? (step.result as any).warnings
      : [],
  );

  return { steps, warnings };
}

// Main async function to run the introspection and log the results
(async function main({
  rootDir = ".",
  respectIgnore = true,
  logger = defaultLogger,
}: {
  rootDir?: string;
  respectIgnore?: boolean;
  logger?: Logger;
}) {
  try {
    let ignorePatterns: string[] = [];
    let include: (relPath: string, entry: import("fs").Dirent) => boolean;
    if (respectIgnore) {
      ignorePatterns = await loadIgnorePatterns(rootDir, logger);
      // Always ignore node_modules even if not in .gitignore
      if (!ignorePatterns.includes("node_modules"))
        ignorePatterns.push("node_modules");
      logger.log("Using ignore patterns:", ignorePatterns);
      const ig = ignore().add(ignorePatterns);
      include = (relPath) => !ig.ignores(relPath);
    } else {
      // Always ignore node_modules
      include = (relPath) =>
        !(relPath === "node_modules" || relPath.startsWith("node_modules/"));
    }
    const startTime = Date.now();
    const report = await introspect(rootDir, include, logger);
    const endTime = Date.now();
    const durationMs = endTime - startTime;
    logger.log({
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      durationMs,
      ...report,
    });
  } catch (err) {
    (logger || defaultLogger).error("Error introspecting project:", err);
  }
})({
  rootDir: process.argv[2] || process.cwd(),
  respectIgnore: process.argv.includes("--ignore") || true,
});
