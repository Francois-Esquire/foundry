import { promises as fs } from "fs";
import path from "path";

import type { EnvManagementResult, Logger } from "./types";

export async function detectEnvManagement(
  rootDir: string,
  logger: Logger,
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
