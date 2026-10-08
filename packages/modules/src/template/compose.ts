import { digestJson } from "@foundry/lib/digest";
import {
  isPortableRelativePath,
  MODULE_MANIFEST_SOURCE_PATH,
} from "../manifest";
import type { ModuleSdkPack } from "../sdk";
import { assertModuleSdkPack } from "../sdk";
import { formatJson, isRecord, parseJsonRecord } from "./json";
import {
  APP_DEPENDENCIES,
  APP_DEV_DEPENDENCIES,
  APP_PACKAGE_SCRIPTS,
  DATABASE_PACKAGE_FILES,
  ESLINT_CONFIGURATION_SOURCE,
  MODULE_VITE_CONFIGURATION_SOURCE,
  moduleProjectReadme,
  PACKAGE_MANAGER,
  PACKAGE_WIRING_FILES,
  PRETTIER_IGNORE_SOURCE,
  ROOT_DEV_DEPENDENCIES,
  SERVER_PACKAGE_FILES,
  TURBO_CONFIGURATION_SOURCE,
  WORKSPACE_SCRIPTS,
} from "./scaffold";

export const MODULE_TEMPLATE_COMPOSER_GENERATION = 12;
export const MODULE_TEMPLATE_COMPOSER_VERSION =
  `foundry.module-template/${MODULE_TEMPLATE_COMPOSER_GENERATION}` as const;

export interface ModuleProjectIdentity {
  readonly displayName: string;
  readonly id: string;
  readonly packageName: string;
}

/**
 * The application a Module workspace is composed from: a file tree with a
 * runnable `package.json`, plus the facts composition reads.
 */
export interface ModuleBase {
  readonly files: Readonly<Record<string, string>>;
  readonly id: string;
  readonly instructions?: string;
  readonly name: string;
}

/** How a host runs a composed Module workspace. */
export interface ModuleTemplateManifest {
  readonly environment: "system";
  readonly ports: readonly number[];
  readonly previewPort: number;
  readonly services: readonly string[];
}

/** A composed Module workspace: its files and how a host runs them. */
export interface ModuleTemplate {
  readonly description: string;
  readonly files: Readonly<Record<string, string>>;
  readonly id: string;
  readonly instructions: string;
  readonly manifest: ModuleTemplateManifest;
  readonly name: string;
  readonly startCommand: string;
}

export interface ComposeModuleTemplateInput {
  readonly base: ModuleBase;
  readonly project: ModuleProjectIdentity;
  readonly sdk: ModuleSdkPack;
}

export class ModuleTemplateCompositionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModuleTemplateCompositionError";
  }
}

const projectIdPattern = /^[a-z][a-z0-9-]*$/;
const packageNamePattern = /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/;
const RESERVED_TEMPLATE_PATHS = [
  "bun.lock",
  ".foundry",
  "packages/app",
  "packages/database",
  "packages/module-sdk",
  "packages/server",
] as const;

/** The only supported composition path from an application base to a Module. */
export async function composeModuleTemplate(
  input: ComposeModuleTemplateInput
): Promise<ModuleTemplate> {
  validateProjectIdentity(input.project);
  validateBase(input.base);
  try {
    await assertModuleSdkPack(input.sdk);
  } catch (error) {
    throw new ModuleTemplateCompositionError(
      error instanceof Error ? error.message : "Invalid Module SDK pack",
      { cause: error }
    );
  }

  const appFiles = cloneApplicationFiles(input.base, input.project.packageName);
  const baseDigest = await digestJson({
    files: input.base.files,
    id: input.base.id,
  });
  const provenance = {
    base: { digest: baseDigest, id: input.base.id },
    format: MODULE_TEMPLATE_COMPOSER_VERSION,
    sdk: { digest: input.sdk.digest, version: input.sdk.version },
  } as const;

  const files: Record<string, string> = {
    ...fixedWorkspaceFiles(input.project, provenance),
  };
  addFiles(files, "packages/app", appFiles);
  addFiles(files, "packages/module-sdk", input.sdk.files);

  const manifest: ModuleTemplateManifest = {
    environment: "system",
    ports: [3000, 5173],
    previewPort: 5173,
    services: ["bun run dev"],
  };

  return Object.freeze({
    description: `Module workspace composed from ${input.base.name}`,
    files: Object.freeze(files),
    id: input.project.id,
    instructions:
      `${input.base.instructions ?? ""}\n\n` +
      "This is a Foundry Module workspace. Keep one Program in packages/server; " +
      "use packages/database for Drizzle state and @foundry/module-sdk for Gateway mechanics.",
    manifest: Object.freeze(manifest),
    name: input.project.displayName,
    startCommand: "bun run dev",
  });
}

/**
 * Why `base`'s files cannot become a Module workspace, or null when they can.
 * Composition applies the same rule, so a caller can check a base up front.
 */
export function moduleTemplateBaseIssue(base: ModuleBase): string | null {
  if (!Object.hasOwn(base.files, "package.json")) {
    return `Module base ${base.id} does not contain package.json`;
  }
  const packageSource = parseJsonRecord(base.files["package.json"]);
  if (packageSource === null) {
    return `Module base ${base.id} has an invalid package.json`;
  }
  if (
    !isRecord(packageSource.scripts) ||
    typeof packageSource.scripts.build !== "string" ||
    packageSource.scripts.build.trim() === ""
  ) {
    return `Module base ${base.id} does not provide an application build command`;
  }
  if (packageSource.workspaces !== undefined) {
    return `Module base ${base.id} declares workspaces the composer owns`;
  }
  for (const path of Object.keys(base.files)) {
    const reserved = RESERVED_TEMPLATE_PATHS.find(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`)
    );
    if (reserved !== undefined) {
      return `Module base ${base.id} declares reserved Module composer path ${JSON.stringify(path)}`;
    }
  }
  return null;
}

function validateProjectIdentity(project: ModuleProjectIdentity): void {
  if (!projectIdPattern.test(project.id)) {
    throw new ModuleTemplateCompositionError(
      `Invalid Module project id ${JSON.stringify(project.id)}`
    );
  }
  if (!packageNamePattern.test(project.packageName)) {
    throw new ModuleTemplateCompositionError(
      `Invalid Module package name ${JSON.stringify(project.packageName)}`
    );
  }
  if (project.displayName.trim().length === 0) {
    throw new ModuleTemplateCompositionError(
      "Module project display name must not be empty"
    );
  }
}

function validateBase(base: ModuleBase): void {
  const issue = moduleTemplateBaseIssue(base);
  if (issue !== null) {
    throw new ModuleTemplateCompositionError(issue);
  }
}

/** Runs after `validateBase`, so `package.json` is a record without workspaces. */
function cloneApplicationFiles(
  base: ModuleBase,
  packageName: string
): Readonly<Record<string, string>> {
  const files = { ...base.files };
  const parsed = parseJsonRecord(files["package.json"]);
  if (parsed === null) {
    throw new ModuleTemplateCompositionError("Base package.json is invalid");
  }
  files["package.json"] = formatJson({
    ...parsed,
    dependencies: {
      ...(isRecord(parsed.dependencies) ? parsed.dependencies : {}),
      "@foundry/module-sdk": "workspace:*",
      ...APP_DEPENDENCIES,
    },
    devDependencies: {
      ...(isRecord(parsed.devDependencies) ? parsed.devDependencies : {}),
      ...APP_DEV_DEPENDENCIES,
    },
    name: `${packageName}-app`,
    private: true,
    scripts: {
      ...(isRecord(parsed.scripts) ? parsed.scripts : {}),
      ...APP_PACKAGE_SCRIPTS,
    },
  });
  files["vite.config.ts"] = MODULE_VITE_CONFIGURATION_SOURCE;
  return Object.freeze(files);
}

function fixedWorkspaceFiles(
  project: ModuleProjectIdentity,
  provenance: object
): Record<string, string> {
  return {
    ...rootWorkspaceFiles(project, provenance),
    ...DATABASE_PACKAGE_FILES,
    ...SERVER_PACKAGE_FILES,
    ...PACKAGE_WIRING_FILES,
  };
}

function rootWorkspaceFiles(
  project: ModuleProjectIdentity,
  provenance: object
): Record<string, string> {
  return {
    ".foundry/provenance.json": formatJson(provenance),
    ".gitignore":
      ".tmp/\n.turbo/\nnode_modules/\npackages/*/dist/\n!packages/module-sdk/dist/\n!packages/module-sdk/dist/**\npackages/*/generated/\npackages/database/.data/\n*.sqlite*\n",
    ".prettierignore": PRETTIER_IGNORE_SOURCE,
    "package.json": formatJson({
      devDependencies: {
        "@foundry/module-sdk": "workspace:*",
        ...ROOT_DEV_DEPENDENCIES,
      },
      name: project.packageName,
      packageManager: PACKAGE_MANAGER,
      private: true,
      scripts: WORKSPACE_SCRIPTS,
      type: "module",
      workspaces: ["packages/*"],
    }),
    "README.md": moduleProjectReadme(project),
    [MODULE_MANIFEST_SOURCE_PATH]: formatJson({
      capabilities: [],
      compatibility: { gateway: "1", runtime: "bun@1" },
      data: { protocol: "drizzle-sqlite@1" },
      format: "foundry.module/1",
      program: { entry: "outputs/packages/server/dist/index.js" },
      views: { home: { path: "/", title: project.displayName } },
    }),
    "eslint.config.js": ESLINT_CONFIGURATION_SOURCE,
    "tsconfig.json": formatJson({
      compilerOptions: {
        jsx: "react-jsx",
        module: "Preserve",
        moduleResolution: "bundler",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2022",
        types: ["bun", "react", "react-dom"],
      },
      include: ["packages"],
    }),
    "turbo.json": TURBO_CONFIGURATION_SOURCE,
  };
}

function addFiles(
  target: Record<string, string>,
  prefix: string,
  source: Readonly<Record<string, string>>
): void {
  for (const [path, value] of Object.entries(source)) {
    if (!isPortableRelativePath(path)) {
      throw new ModuleTemplateCompositionError(
        `Injected file path ${JSON.stringify(path)} is not portable`
      );
    }
    const destination = `${prefix}/${path}`;
    if (target[destination] !== undefined) {
      throw new ModuleTemplateCompositionError(
        `Module template path collision at ${destination}`
      );
    }
    target[destination] = value;
  }
}
