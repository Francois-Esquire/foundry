import type {
  CreateModuleSystemOptions,
  ModuleSystem,
} from "../platform/system";
import { createModuleSystem as createSystem } from "../platform/system";
import { createModuleCheckouts } from "./checkouts";
import type { CreateModuleInstallationFilesOptions } from "./installation-files";
import { createModuleInstallationFiles } from "./installation-files";

export interface CreateNodeModuleSystemOptions
  extends Omit<CreateModuleSystemOptions, "checkouts" | "files"> {
  readonly checkoutsRoot: string;
  readonly files: CreateModuleInstallationFilesOptions;
}

export function createModuleSystem(
  options: CreateNodeModuleSystemOptions
): ModuleSystem {
  return createSystem({
    ...options,
    checkouts: createModuleCheckouts({
      artifacts: options.artifacts,
      root: options.checkoutsRoot,
    }),
    files: createModuleInstallationFiles(options.files),
  });
}
