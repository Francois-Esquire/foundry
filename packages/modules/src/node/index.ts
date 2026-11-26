// biome-ignore lint/performance/noBarrelFile: Public Node entry point keeps filesystem and OS adapters out of portable imports.
export {
  createModuleCheckouts,
  ModuleCheckoutError,
  type ModuleCheckouts,
} from "./checkouts";
export {
  type CreateModuleInstallationFilesOptions,
  createModuleInstallationFiles,
  DEFAULT_INSTALLATION_FILES_QUOTA_BYTES,
  type ModuleInstallationFiles,
  ModuleInstallationFilesError,
  type PreparedInstallationFiles,
} from "./installation-files";
export {
  type CreateNodeModulePlatformOptions,
  createNodeModulePlatform,
} from "./platform";
export {
  type CreateModuleSelectedCheckoutsOptions,
  createModuleSelectedCheckouts,
} from "./selected-checkouts";
export { captureModuleWorkspaceSource } from "./source-capture";
