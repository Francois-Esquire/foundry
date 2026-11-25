// biome-ignore lint/performance/noBarrelFile: Public platform role entry point for @foundry/modules/platform.
export { KeyedQueue as KeyedTurns } from "@foundry/lib/keyed-queue";
export {
  ModuleActivationRefusedError,
  validateModuleActivation,
} from "./activation";
export {
  ModuleRuntimeCleanupError,
  rethrowAfterCleanup,
  withConfirmedModuleContainerCleanup,
} from "./container-cleanup";
export {
  type CreateContainerModuleProgramRuntimeOptions,
  createContainerModuleProgramRuntime,
} from "./container-runtime";
export type {
  ModuleActivationInput,
  ModuleProgramLaunch,
  ModuleProgramResources,
  ModuleProgramRuntimeAdapter,
  ModuleProgramRuntimeHandle,
  ModuleProgramSupervisor,
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
