import type { BaseStep, Logger } from "./types";
import * as fs from "fs";
import * as path from "path";
// Using require for glob to avoid TypeScript declaration file issues
const glob = require("glob");

type ComponentSystemResult = {
  uiFrameworks: Record<string, boolean>;
  componentLibraries: Record<string, boolean>;
  designSystems: Record<string, boolean>;
  componentPatterns: Record<string, boolean>;
  componentFiles: string[];
  storyFiles: string[];
  testFiles: string[];
  warnings: string[];
};

export async function detectComponentSystem(
  rootDir: string,
  logger: Logger,
): Promise<BaseStep> {
  const startTime = new Date();
  logger.log("Running component system detection...");
  
  const result: ComponentSystemResult = {
    uiFrameworks: {},
    componentLibraries: {},
    designSystems: {},
    componentPatterns: {},
    componentFiles: [],
    storyFiles: [],
    testFiles: [],
    warnings: [],
  };

  try {
    // Check package.json for UI frameworks and component libraries
    const packageJsonPath = path.join(rootDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        const allDeps = {
          ...(packageJson.dependencies || {}),
          ...(packageJson.devDependencies || {})
        };
        
        // UI Frameworks
        const uiFrameworks: Record<string, string[]> = {
          "react": ["react", "react-dom"],
          "vue": ["vue", "@vue/cli", "vue-loader"],
          "angular": ["@angular/core", "@angular/common"],
          "svelte": ["svelte", "svelte-loader"],
          "solid": ["solid-js"],
          "lit": ["lit", "lit-element", "lit-html"],
          "preact": ["preact"],
          "nextjs": ["next"],
          "nuxt": ["nuxt", "nuxt3"],
          "remix": ["@remix-run/react"],
          "qwik": ["@builder.io/qwik"],
        };
        
        for (const [framework, packages] of Object.entries(uiFrameworks)) {
          if (packages.some(pkg => pkg in allDeps)) {
            result.uiFrameworks[framework] = true;
          }
        }
        
        // Component Libraries
        const componentLibraries: Record<string, string[]> = {
          "material-ui": ["@mui/material", "@material-ui/core"],
          "chakra-ui": ["@chakra-ui/react"],
          "ant-design": ["antd", "@ant-design/icons"],
          "tailwind": ["tailwindcss"],
          "bootstrap": ["bootstrap", "react-bootstrap"],
          "shadcn-ui": ["@shadcn/ui"],
          "radix-ui": ["@radix-ui/react-dialog", "@radix-ui/react-popover", "@radix-ui/primitives"],
          "headless-ui": ["@headlessui/react", "@headlessui/vue"],
          "styled-components": ["styled-components"],
          "emotion": ["@emotion/react", "@emotion/styled"],
          "storybook": ["@storybook/react", "@storybook/vue", "@storybook/angular"],
          "framer-motion": ["framer-motion"],
          "blueprint": ["@blueprintjs/core"],
          "mantine": ["@mantine/core"],
          "primereact": ["primereact"],
          "vuetify": ["vuetify"],
          "quasar": ["quasar"],
          "element-plus": ["element-plus"],
          "semantic-ui": ["semantic-ui-react"],
        };
        
        for (const [library, packages] of Object.entries(componentLibraries)) {
          if (packages.some(pkg => pkg in allDeps)) {
            result.componentLibraries[library] = true;
          }
        }
        
        // Design Systems
        const designSystems: Record<string, string[]> = {
          "storybook": ["@storybook/react", "@storybook/vue", "@storybook/angular"],
          "chromatic": ["chromatic"],
          "zeroheight": ["zeroheight"],
          "figma-tokens": ["figma-tokens"],
          "style-dictionary": ["style-dictionary"],
          "theme-ui": ["theme-ui"],
          "system-ui": ["@system-ui/theme"],
        };
        
        for (const [system, packages] of Object.entries(designSystems)) {
          if (packages.some(pkg => pkg in allDeps)) {
            result.designSystems[system] = true;
          }
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        result.warnings.push(`Error parsing package.json: ${errorMessage}`);
      }
    } else {
      result.warnings.push("package.json not found");
    }
    
    // Check for configuration files
    const configFiles: Record<string, string[]> = {
      "tailwind": ["tailwind.config.js", "tailwind.config.ts"],
      "storybook": [".storybook/main.js", ".storybook/main.ts"],
      "styled-components": [".styled-components.js", "styled-components.config.js"],
      "theme-ui": ["theme.js", "theme.ts"],
      "shadcn-ui": ["components.json"],
    };
    
    for (const [tool, files] of Object.entries(configFiles)) {
      for (const file of files) {
        const filePath = path.join(rootDir, file);
        if (fs.existsSync(filePath)) {
          if (tool === "storybook") {
            result.designSystems[tool] = true;
          } else {
            result.componentLibraries[tool] = true;
          }
          break;
        }
      }
    }
    
    // Look for component patterns
    try {
      // Find component files
      let componentPatterns: string[] = [];
      
      // React/Preact patterns
      if (result.uiFrameworks.react || result.uiFrameworks.preact || result.uiFrameworks.nextjs) {
        componentPatterns = componentPatterns.concat([
          "**/components/**/*.{jsx,tsx}",
          "**/Components/**/*.{jsx,tsx}",
          "**/*.component.{jsx,tsx}",
          "**/src/**/[A-Z]*.{jsx,tsx}",
        ]);
      }
      
      // Vue patterns
      if (result.uiFrameworks.vue || result.uiFrameworks.nuxt) {
        componentPatterns = componentPatterns.concat([
          "**/*.vue",
          "**/components/**/*.{js,ts}",
          "**/Components/**/*.{js,ts}",
        ]);
      }
      
      // Angular patterns
      if (result.uiFrameworks.angular) {
        componentPatterns = componentPatterns.concat([
          "**/*.component.ts",
          "**/components/**/*.ts",
        ]);
      }
      
      // Svelte patterns
      if (result.uiFrameworks.svelte) {
        componentPatterns = componentPatterns.concat([
          "**/*.svelte",
        ]);
      }
      
      // Find component files
      let componentFiles: string[] = [];
      for (const pattern of componentPatterns) {
        const files = glob.sync(pattern, { 
          cwd: rootDir, 
          ignore: ["**/node_modules/**", "**/dist/**", "**/build/**"] 
        });
        componentFiles = componentFiles.concat(files);
      }
      
      // Remove duplicates
      componentFiles = [...new Set(componentFiles)];
      result.componentFiles = componentFiles.slice(0, 50); // Limit to 50 files
      
      // Analyze component patterns
      if (componentFiles.length > 0) {
        // Check for story files
        const storyFiles = glob.sync("**/*.stories.{js,jsx,ts,tsx,mdx}", { 
          cwd: rootDir, 
          ignore: ["**/node_modules/**", "**/dist/**", "**/build/**"] 
        });
        result.storyFiles = storyFiles.slice(0, 20); // Limit to 20 files
        
        if (storyFiles.length > 0) {
          result.componentPatterns["storybook"] = true;
        }
        
        // Check for test files
        const testPatterns = [
          "**/*.test.{js,jsx,ts,tsx}",
          "**/*.spec.{js,jsx,ts,tsx}",
          "**/__tests__/**/*.{js,jsx,ts,tsx}",
        ];
        
        let testFiles: string[] = [];
        for (const pattern of testPatterns) {
          const files = glob.sync(pattern, { 
            cwd: rootDir, 
            ignore: ["**/node_modules/**", "**/dist/**", "**/build/**"] 
          });
          testFiles = testFiles.concat(files);
        }
        
        // Remove duplicates
        testFiles = [...new Set(testFiles)];
        result.testFiles = testFiles.slice(0, 20); // Limit to 20 files
        
        if (testFiles.length > 0) {
          result.componentPatterns["tested-components"] = true;
        }
        
        // Sample some component files to detect patterns
        const sampleFiles = componentFiles.slice(0, 5);
        let hasHooks = false;
        let hasProps = false;
        let hasStyled = false;
        let hasCSS = false;
        
        for (const file of sampleFiles) {
          try {
            const content = fs.readFileSync(path.join(rootDir, file), "utf8");
            
            // React hooks
            if (content.includes("useState") || content.includes("useEffect") || 
                content.includes("useContext") || content.includes("useReducer")) {
              hasHooks = true;
            }
            
            // Props typing
            if (content.includes(": Props") || content.includes("type Props") || 
                content.includes("interface Props")) {
              hasProps = true;
            }
            
            // Styled components
            if (content.includes("styled.") || content.includes("createStyles") || 
                content.includes("makeStyles")) {
              hasStyled = true;
            }
            
            // CSS modules or imports
            if (content.includes("import styles from") || content.includes("import './") || 
                content.includes("import \"./")) {
              hasCSS = true;
            }
          } catch (_: unknown) {
            // Skip if can't read file
          }
        }
        
        if (hasHooks) result.componentPatterns["react-hooks"] = true;
        if (hasProps) result.componentPatterns["typed-props"] = true;
        if (hasStyled) result.componentPatterns["styled-components"] = true;
        if (hasCSS) result.componentPatterns["css-modules"] = true;
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      result.warnings.push(`Error analyzing component files: ${errorMessage}`);
    }
    
    // Add recommendations
    if (Object.keys(result.uiFrameworks).length === 0) {
      result.warnings.push("No UI frameworks detected");
    }
    
    if (Object.keys(result.componentLibraries).length === 0 && 
        Object.keys(result.uiFrameworks).length > 0) {
      result.warnings.push("UI framework detected but no component libraries found");
    }
    
    if (result.componentFiles.length > 0 && result.storyFiles.length === 0) {
      result.warnings.push("Components found but no Storybook stories detected. Consider adding Storybook for component documentation.");
    }
    
    if (result.componentFiles.length > 0 && result.testFiles.length === 0) {
      result.warnings.push("Components found but no tests detected. Consider adding tests for your components.");
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error in component system detection: ${errorMessage}`);
    result.warnings.push(`Error in component system detection: ${errorMessage}`);
  }

  const endTime = new Date();
  const durationMs = endTime.getTime() - startTime.getTime();

  return {
    name: "detectComponentSystem",
    durationMs,
    result,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
  };
}
