import type { BaseStep, Logger } from "./types";
import * as fs from "fs";
import * as path from "path";

export async function detectLicenseMetadata(
  rootDir: string,
  logger: Logger,
): Promise<BaseStep> {
  const startTime = new Date();
  logger.log("Running license and metadata detection...");
  
  const result = {
    licenseFile: null as string | null,
    licenseType: null as string | null,
    packageJsonLicense: null as string | null,
    authorInfo: null as string | null,
    warnings: [] as string[],
  };

  try {
    // Check for LICENSE file (various formats)
    const licenseFileVariants = [
      "LICENSE",
      "LICENSE.md",
      "LICENSE.txt",
      "license",
      "license.md",
      "license.txt",
    ];

    for (const variant of licenseFileVariants) {
      const licensePath = path.join(rootDir, variant);
      if (fs.existsSync(licensePath)) {
        result.licenseFile = variant;
        
        // Try to determine license type from content
        try {
          const content = fs.readFileSync(licensePath, "utf8");
          if (content.includes("MIT License")) {
            result.licenseType = "MIT";
          } else if (content.includes("Apache License")) {
            result.licenseType = "Apache";
          } else if (content.includes("GNU GENERAL PUBLIC LICENSE")) {
            if (content.includes("Version 3")) {
              result.licenseType = "GPL-3.0";
            } else if (content.includes("Version 2")) {
              result.licenseType = "GPL-2.0";
            } else {
              result.licenseType = "GPL";
            }
          } else if (content.includes("BSD")) {
            result.licenseType = "BSD";
          } else {
            result.licenseType = "Unknown";
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          result.warnings.push(`Could not read license file: ${errorMessage}`);
        }
        
        break;
      }
    }

    if (!result.licenseFile) {
      result.warnings.push("No LICENSE file found in project root");
    }

    // Extract license field from package.json
    const packageJsonPath = path.join(rootDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        
        if (packageJson.license) {
          result.packageJsonLicense = packageJson.license;
        } else {
          result.warnings.push("No license field found in package.json");
        }
        
        // Extract author information
        if (packageJson.author) {
          if (typeof packageJson.author === "string") {
            result.authorInfo = packageJson.author;
          } else if (typeof packageJson.author === "object") {
            result.authorInfo = JSON.stringify(packageJson.author);
          }
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        result.warnings.push(`Error parsing package.json: ${errorMessage}`);
      }
    } else {
      result.warnings.push("package.json not found");
    }
    
    // Check if license information is consistent
    if (result.licenseType && result.packageJsonLicense && 
        result.licenseType !== result.packageJsonLicense) {
      result.warnings.push(
        `License mismatch: LICENSE file indicates "${result.licenseType}" but package.json specifies "${result.packageJsonLicense}"`
      );
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error in license detection: ${errorMessage}`);
    result.warnings.push(`Error in license detection: ${errorMessage}`);
  }

  const endTime = new Date();
  const durationMs = endTime.getTime() - startTime.getTime();

  return {
    name: "detectLicenseMetadata",
    durationMs,
    result,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
  };
}
