import * as fs from "fs";
import * as path from "path";

import type { BaseStep, Logger } from "./types";

type BuildToolResult = {
  buildTools: Record<string, boolean>;
  configFiles: string[];
  warnings: string[];
};

export async function detectBuildTools(
  rootDir: string,
  logger: Logger,
): Promise<BaseStep> {
  const startTime = new Date();
  logger.log("Running build tools detection...");

  const result: BuildToolResult = {
    buildTools: {},
    configFiles: [],
    warnings: [],
  };

  try {
    // Define common build tools and their config files
    const buildToolConfigs: Record<string, string[]> = {
      webpack: [
        "webpack.config.js",
        "webpack.config.ts",
        "webpack.common.js",
        "webpack.dev.js",
        "webpack.prod.js",
        "webpack.*.{js,ts,ts,js,mjs}",
      ],
      vite: ["vite.config.js", "vite.config.ts"],
      rollup: ["rollup.config.js", "rollup.config.ts", "rollup.config.mjs"],
      parcel: [".parcelrc", "parcel.config.js"],
      esbuild: ["esbuild.config.js", "esbuild.config.ts"],
      swc: [".swcrc", "swc.config.js"],
      babel: [
        ".babelrc",
        ".babelrc.js",
        "babel.config.js",
        "babel.config.json",
      ],
      typescript: ["tsconfig.json", "tsconfig.app.json", "tsconfig.build.json"],
      turbopack: ["turbo.json"],
      snowpack: [
        "snowpack.config.js",
        "snowpack.config.ts",
        "snowpack.config.mjs",
      ],
      gulp: ["gulpfile.js", "gulpfile.ts", "gulpfile.babel.js"],
      grunt: ["Gruntfile.js", "Gruntfile.coffee"],
      browserify: ["browserify.config.js"],
      microbundle: ["microbundle.config.js"],
      metro: ["metro.config.js", "metro.config.json"],
      nx: ["nx.json", "workspace.json"],
      tsc: ["tsconfig.json"],
    };

    // Check for each build tool's config files
    for (const [tool, configFiles] of Object.entries(buildToolConfigs)) {
      for (const configFile of configFiles) {
        const configPath = path.join(rootDir, configFile);
        if (fs.existsSync(configPath)) {
          result.buildTools[tool] = true;
          result.configFiles.push(configFile);

          // For some tools, try to extract more information
          if (tool === "typescript" && configFile === "tsconfig.json") {
            try {
              const tsConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
              if (tsConfig.compilerOptions) {
                if (tsConfig.compilerOptions.target) {
                  result.buildTools[
                    `typescript-target-${tsConfig.compilerOptions.target.toLowerCase()}`
                  ] = true;
                }
                if (tsConfig.compilerOptions.module) {
                  result.buildTools[
                    `typescript-module-${tsConfig.compilerOptions.module.toLowerCase()}`
                  ] = true;
                }
              }
            } catch (err: unknown) {
              const errorMessage =
                err instanceof Error ? err.message : String(err);
              result.warnings.push(
                `Error parsing tsconfig.json: ${errorMessage}`,
              );
            }
          }

          break;
        }
      }
    }

    // Check package.json for build scripts and dependencies
    const packageJsonPath = path.join(rootDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(
          fs.readFileSync(packageJsonPath, "utf8"),
        );

        // Check scripts for build tools
        if (packageJson.scripts) {
          const scripts = packageJson.scripts;

          if (scripts.build) {
            // Analyze build script
            const buildScript = scripts.build.toLowerCase();
            if (buildScript.includes("webpack"))
              result.buildTools["webpack"] = true;
            if (buildScript.includes("vite")) result.buildTools["vite"] = true;
            if (buildScript.includes("rollup"))
              result.buildTools["rollup"] = true;
            if (buildScript.includes("parcel"))
              result.buildTools["parcel"] = true;
            if (buildScript.includes("esbuild"))
              result.buildTools["esbuild"] = true;
            if (buildScript.includes("tsc")) result.buildTools["tsc"] = true;
            if (buildScript.includes("swc")) result.buildTools["swc"] = true;
            if (buildScript.includes("babel"))
              result.buildTools["babel"] = true;
            if (buildScript.includes("next build"))
              result.buildTools["nextjs"] = true;
            if (buildScript.includes("vue-cli-service build"))
              result.buildTools["vue-cli"] = true;
            if (buildScript.includes("ng build"))
              result.buildTools["angular-cli"] = true;
          }
        }

        // Check dependencies for build tools
        const allDeps = {
          ...(packageJson.dependencies || {}),
          ...(packageJson.devDependencies || {}),
        };

        const depToTool: Record<string, string> = {
          webpack: "webpack",
          "webpack-cli": "webpack",
          "webpack-dev-server": "webpack",
          vite: "vite",
          rollup: "rollup",
          parcel: "parcel",
          esbuild: "esbuild",
          "@swc/core": "swc",
          "@babel/core": "babel",
          "babel-loader": "babel",
          typescript: "typescript",
          turbo: "turbopack",
          snowpack: "snowpack",
          gulp: "gulp",
          grunt: "grunt",
          browserify: "browserify",
          microbundle: "microbundle",
          metro: "metro",
          nx: "nx",
          next: "nextjs",
          "@angular/cli": "angular-cli",
          "@vue/cli-service": "vue-cli",
          "react-scripts": "create-react-app",
        };

        for (const [dep, tool] of Object.entries(depToTool)) {
          if (dep in allDeps) {
            result.buildTools[tool] = true;
          }
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        result.warnings.push(`Error parsing package.json: ${errorMessage}`);
      }
    } else {
      result.warnings.push("package.json not found");
    }

    // Check for other common build-related files
    const otherBuildFiles = [
      ".browserslistrc",
      ".nvmrc",
      ".eslintrc.js",
      ".eslintrc.json",
      ".prettierrc",
      ".prettierrc.js",
      "postcss.config.js",
      "tailwind.config.js",
    ];

    for (const file of otherBuildFiles) {
      const filePath = path.join(rootDir, file);
      if (fs.existsSync(filePath)) {
        result.configFiles.push(file);
      }
    }

    // If no build tools detected
    if (Object.keys(result.buildTools).length === 0) {
      result.warnings.push("No build tools detected");
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error in build tools detection: ${errorMessage}`);
    result.warnings.push(`Error in build tools detection: ${errorMessage}`);
  }

  const endTime = new Date();
  const durationMs = endTime.getTime() - startTime.getTime();

  return {
    name: "detectBuildTools",
    durationMs,
    result,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
  };
}
