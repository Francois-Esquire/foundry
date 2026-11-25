// biome-ignore lint/performance/noBarrelFile: Public platform role entry point for @foundry/modules/platform.
export {
  type ModuleActivationInput,
  ModuleActivationRefusedError,
  validateModuleActivation,
} from "./activation";
export { withConfirmedModuleContainerCleanup } from "./container-cleanup";
export {
  type CreateContainerModuleProgramRuntimeOptions,
  createContainerModuleProgramRuntime,
} from "./container-runtime";
export {
  type ModuleProgramLaunch,
  type ModuleProgramResources,
  type ModuleProgramRuntimeAdapter,
  type ModuleProgramRuntimeHandle,
  type ModuleProgramSupervisor,
  ModuleRuntimeCleanupError,
  rethrowAfterCleanup,
} from "./contracts";
export type {
  ModuleCheckouts,
  ModuleFilesPersistence,
  ModuleInstallationFiles,
  ModuleSelectedCheckouts,
  PreparedInstallationFiles,
} from "./files";
export {
  type CreateModuleInstallationsOptions,
  createModuleInstallations,
  type ModuleInstallations,
} from "./installations";
export {
  type CreateModulePlatformOptions,
  createModulePlatform,
  type ModulePlatform,
} from "./platform";
export {
  type CreateModuleProgramRuntimeOptions,
  createModuleProgramRuntime,
  MODULE_FILES_ROOT,
  MODULE_PROGRAM_PORT,
  MODULE_PROGRAM_ROOT,
  type ModuleProgramContainer,
  ModuleProgramRuntimeError,
  type ModuleProgramRuntimeErrorCode,
} from "./program-runtime";
export {
  type CreateModuleProgramSupervisorOptions,
  createModuleProgramSupervisor,
  ModuleProgramSupervisorError,
  type ModuleProgramSupervisorErrorCode,
} from "./program-supervisor";
export {
  type CreateModuleRuntimeRecoveryOptions,
  createModuleRuntimeRecovery,
  type ModuleRecoveryResult,
  type ModuleRuntimeRecovery,
} from "./runtime-recovery";
export { KeyedTurns } from "./turns";
