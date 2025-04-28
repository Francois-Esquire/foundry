import { promises as fs } from "fs";
import path from "path";

import type { Logger, ProjectNormalizationResult } from "./types";

export async function normalizeProject(
  rootDir: string,
  logger: Logger,
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
          .filter((k): k is string => !!k) || [];
      const exampleKeys =
        exampleContent
          .split("\n")
          .map((l) => l.split("=")[0]?.trim())
          .filter((k): k is string => !!k) || [];
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
  } catch (err) {
    // ignore if no .env files
  }
  return { normalized, actions, warnings };
}
