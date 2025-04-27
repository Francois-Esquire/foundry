// Core library exports
import { type Adapter } from '../adapters/types';
import { type ServiceRegistry, ServiceRegistryImpl } from './registry';
import {
  type CommandProcessor,
  CommandProcessorImpl,
} from '../consumers/command-processor';
import { type WorkflowEngine, WorkflowEngineImpl } from './workflow-engine';
import { type TaskManager, TaskManagerImpl } from './task-manager';
import {
  type DocumentGenerator,
  DocumentGeneratorImpl,
} from '../generators/generator';
import {
  FoundryLibrary,
  type FoundryLibraryOptions,
  type FoundryLibraryInterface,
} from './foundry';
import {
  type Extension,
  type ExtensionMetadata,
  type MCPExtension,
  type MCPExtensionConfig,
  type ToolExtension,
  ExtensionRegistry,
  ExtensionType,
  extensionRegistry,
} from './extensions';

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
