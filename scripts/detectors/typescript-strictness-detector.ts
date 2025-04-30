import type { BaseStep, Logger } from "./types";
import * as fs from "fs";
import * as path from "path";
// Using require for glob to avoid TypeScript declaration file issues
const glob = require("glob");

type TypeScriptStrictnessResult = {
  isTypeScriptProject: boolean;
  strictnessLevel: "none" | "low" | "medium" | "high" | "strict";
  compilerOptions: Record<string, unknown>;
  strictSettings: Record<string, boolean>;
  tsFilesCount: number;
  tsxFilesCount: number;
  dtsFilesCount: number;
  hasTypeRoots: boolean;
  hasTypeImports: boolean;
  warnings: string[];
};

export async function detectTypescriptStrictness(
  rootDir: string,
  logger: Logger,
): Promise<BaseStep> {
  const startTime = new Date();
  logger.log("Running TypeScript strictness detection...");
  
  const result: TypeScriptStrictnessResult = {
    isTypeScriptProject: false,
    strictnessLevel: "none",
    compilerOptions: {},
    strictSettings: {},
    tsFilesCount: 0,
    tsxFilesCount: 0,
    dtsFilesCount: 0,
    hasTypeRoots: false,
    hasTypeImports: false,
    warnings: [],
  };

  try {
    // Check if TypeScript is installed by looking for package.json
    const packageJsonPath = path.join(rootDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        const allDeps = {
          ...(packageJson.dependencies || {}),
          ...(packageJson.devDependencies || {})
        };
        
        if ("typescript" in allDeps) {
          result.isTypeScriptProject = true;
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        result.warnings.push(`Error parsing package.json: ${errorMessage}`);
      }
    }

    // Find all tsconfig files
    const tsconfigPaths = glob.sync("**/tsconfig*.json", { 
      cwd: rootDir, 
      ignore: ["**/node_modules/**", "**/dist/**", "**/build/**"] 
    });

    if (tsconfigPaths.length === 0) {
      if (result.isTypeScriptProject) {
        result.warnings.push("TypeScript is installed but no tsconfig.json found");
      } else {
        result.warnings.push("Not a TypeScript project (no tsconfig.json found)");
        return {
          name: "detectTypescriptStrictness",
          durationMs: new Date().getTime() - startTime.getTime(),
          result,
          startTime: startTime.toISOString(),
          endTime: new Date().toISOString(),
        };
      }
    } else {
      result.isTypeScriptProject = true;
      
      // Analyze the main tsconfig.json file
      const mainTsConfigPath = path.join(rootDir, "tsconfig.json");
      if (fs.existsSync(mainTsConfigPath)) {
        try {
          const tsConfig = JSON.parse(fs.readFileSync(mainTsConfigPath, "utf8"));
          
          if (tsConfig.compilerOptions) {
            result.compilerOptions = tsConfig.compilerOptions;
            
            // Check strictness settings
            const strictnessFlags = [
              "strict",
              "noImplicitAny",
              "strictNullChecks",
              "strictFunctionTypes",
              "strictBindCallApply",
              "strictPropertyInitialization",
              "noImplicitThis",
              "alwaysStrict",
              "noUnusedLocals",
              "noUnusedParameters",
              "noImplicitReturns",
              "noFallthroughCasesInSwitch",
              "noUncheckedIndexedAccess",
              "noImplicitOverride",
              "noPropertyAccessFromIndexSignature",
            ];
            
            let strictCount = 0;
            for (const flag of strictnessFlags) {
              if (tsConfig.compilerOptions[flag] === true) {
                result.strictSettings[flag] = true;
                strictCount++;
              } else {
                result.strictSettings[flag] = false;
              }
            }
            
            // Determine strictness level
            if (tsConfig.compilerOptions.strict === true) {
              result.strictnessLevel = "strict";
            } else if (strictCount >= 10) {
              result.strictnessLevel = "high";
            } else if (strictCount >= 5) {
              result.strictnessLevel = "medium";
            } else if (strictCount > 0) {
              result.strictnessLevel = "low";
            } else {
              result.strictnessLevel = "none";
            }
            
            // Check for typeRoots
            if (tsConfig.compilerOptions.typeRoots) {
              result.hasTypeRoots = true;
            }
          } else {
            result.warnings.push("tsconfig.json exists but has no compilerOptions");
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          result.warnings.push(`Error parsing tsconfig.json: ${errorMessage}`);
        }
      }
    }

    // Count TypeScript files
    try {
      const tsFiles = glob.sync("**/*.ts", { 
        cwd: rootDir, 
        ignore: ["**/node_modules/**", "**/dist/**", "**/build/**"] 
      });
      const tsxFiles = glob.sync("**/*.tsx", { 
        cwd: rootDir, 
        ignore: ["**/node_modules/**", "**/dist/**", "**/build/**"] 
      });
      const dtsFiles = glob.sync("**/*.d.ts", { 
        cwd: rootDir, 
        ignore: ["**/node_modules/**", "**/dist/**", "**/build/**"] 
      });
      
      result.tsFilesCount = tsFiles.length;
      result.tsxFilesCount = tsxFiles.length;
      result.dtsFilesCount = dtsFiles.length;
      
      // Check for type imports in a sample of files
      const sampleFiles = tsFiles.slice(0, 5);
      for (const file of sampleFiles) {
        try {
          const content = fs.readFileSync(path.join(rootDir, file), "utf8");
          if (content.includes("import type ") || content.includes("import { type ")) {
            result.hasTypeImports = true;
            break;
          }
        } catch (_: unknown) {
          // Skip file if can't read
        }
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      result.warnings.push(`Error counting TypeScript files: ${errorMessage}`);
    }
    
    // Add recommendations based on findings
    if (result.isTypeScriptProject) {
      if (result.strictnessLevel === "none" || result.strictnessLevel === "low") {
        result.warnings.push("Consider enabling stricter TypeScript settings for better type safety");
      }
      
      if (!result.hasTypeImports && (result.tsFilesCount + result.tsxFilesCount > 10)) {
        result.warnings.push("Consider using explicit type imports for better code organization");
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error in TypeScript strictness detection: ${errorMessage}`);
    result.warnings.push(`Error in TypeScript strictness detection: ${errorMessage}`);
  }

  const endTime = new Date();
  const durationMs = endTime.getTime() - startTime.getTime();

  return {
    name: "detectTypescriptStrictness",
    durationMs,
    result,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
  };
}
