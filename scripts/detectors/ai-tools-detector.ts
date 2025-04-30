import { promises as fs } from "fs";
import path from "path";

import type { BaseStep, Logger } from "./types";

export async function detectAiTools(
  rootDir: string,
  logger: Logger,
): Promise<BaseStep> {
  // Look for files/directories like windsurf rules, .cursor, .cursorrules, .cursorignore, .roo, etc.
  const aiIndicators = [
    "windsurf.rules",
    ".cursor",
    ".cursorrules",
    ".cursorignore",
    ".roo",
  ];
  const found: string[] = [];
  try {
    const files = await fs.readdir(rootDir);
    for (const indicator of aiIndicators) {
      if (files.includes(indicator)) {
        found.push(indicator);
      }
    }
  } catch (err) {
    logger.warn("Could not read directory for AI tool detection.");
  }
  const warnings =
    found.length > 0
      ? [`AI tool indicators found: ${found.join(", ")}`]
      : ["No AI tool indicators found (windsurf, .cursor, .roo, etc.)."];
  return {
    name: "detectAiTools",
    durationMs: 0,
    result: { found, warnings },
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
  };
}
