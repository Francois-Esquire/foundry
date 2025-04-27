// Core library exports
import type { CommandProcessor } from "../consumers/command-processor";
import type { DocumentGenerator } from "../generators/generator";
import type {
  Extension,
  ExtensionMetadata,
  MCPExtension,
  MCPExtensionConfig,
  ToolExtension,
} from "./extensions";
import type { FoundryLibraryInterface, FoundryLibraryOptions } from "./foundry";
import type { ServiceRegistry } from "./registry";
import type { TaskManager } from "./task-manager";
import type { WorkflowEngine } from "./workflow-engine";

import { type Adapter } from "../adapters/types";
import { CommandProcessorImpl } from "../consumers/command-processor";
import { DocumentGeneratorImpl } from "../generators/generator";
import {
  ExtensionRegistry,
  extensionRegistry,
  ExtensionType,
} from "./extensions";
import { FoundryLibrary } from "./foundry";
import { ServiceRegistryImpl } from "./registry";
import { TaskManagerImpl } from "./task-manager";
import { WorkflowEngineImpl } from "./workflow-engine";

// Re-export core types
export type {
  Adapter,
  ServiceRegistry,
  CommandProcessor,
  WorkflowEngine,
  TaskManager,
  DocumentGenerator,
  FoundryLibraryOptions,
  FoundryLibraryInterface,
  Extension,
  ExtensionMetadata,
  MCPExtension,
  MCPExtensionConfig,
  ToolExtension,
};

// Re-export core implementations
export {
  ServiceRegistryImpl,
  CommandProcessorImpl,
  WorkflowEngineImpl,
  TaskManagerImpl,
  DocumentGeneratorImpl,
  FoundryLibrary,
  ExtensionRegistry,
  ExtensionType,
  extensionRegistry,
};
