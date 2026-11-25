import type {
  CreateModulePlatformOptions,
  ModulePlatform,
} from "../platform/platform";
import { createModulePlatform } from "../platform/platform";
import { createModuleCheckouts } from "./checkouts";
import type { CreateModuleInstallationFilesOptions } from "./installation-files";
import { createModuleInstallationFiles } from "./installation-files";

export interface CreateNodeModulePlatformOptions
  extends Omit<CreateModulePlatformOptions, "checkouts" | "files"> {
  readonly checkoutsRoot: string;
  readonly files: CreateModuleInstallationFilesOptions;
}

export function createNodeModulePlatform(
  options: CreateNodeModulePlatformOptions
): ModulePlatform {
  return createModulePlatform({
    ...options,
    checkouts: createModuleCheckouts({
      artifacts: options.artifacts,
      root: options.checkoutsRoot,
    }),
    files: createModuleInstallationFiles(options.files),
  });
}
