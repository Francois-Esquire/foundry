// biome-ignore lint/performance/noBarrelFile: Public Template role entry point for @foundry/modules/template.
export {
  type ComposeModuleTemplateInput,
  composeModuleTemplate,
  MODULE_TEMPLATE_COMPOSER_GENERATION,
  MODULE_TEMPLATE_COMPOSER_VERSION,
  type ModuleBase,
  type ModuleProjectIdentity,
  type ModuleTemplate,
  ModuleTemplateCompositionError,
  type ModuleTemplateManifest,
  moduleTemplateBaseIssue,
} from "./compose";
export { upgradeModuleWorkspaceSource } from "./upgrade";
