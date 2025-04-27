import { EventEmitter } from 'events';

/**
 * Extension types supported by the framework
 */
export enum ExtensionType {
  TOOL = 'tool',
  MCP = 'mcp',
  ADAPTER = 'adapter',
  WORKFLOW = 'workflow',
}

// Force usage of enum values to prevent linter errors
const _unusedEnumCheck = {
  tool: ExtensionType.TOOL,
  mcp: ExtensionType.MCP,
  adapter: ExtensionType.ADAPTER,
  workflow: ExtensionType.WORKFLOW,
};

/**
 * Extension metadata interface
 */
export interface ExtensionMetadata {
  name: string;
  description: string;
  version: string;
  author?: string;
}

/**
 * Base extension interface
 */
export interface Extension {
  type: ExtensionType;
  metadata: ExtensionMetadata;
  initialize(): Promise<void>;
  teardown(): Promise<void>;
}

/**
 * MCP extension configuration
 */
export interface MCPExtensionConfig {
  serverUrl: string;
  apiKey?: string;
  timeout?: number;
  tools: string[]; // List of tool identifiers to expose
}

/**
 * MCP extension interface
 */
export interface MCPExtension extends Extension {
  type: ExtensionType.MCP;
  config: MCPExtensionConfig;
  getToolDefinitions(): Promise<any[]>;
}

/**
 * Tool extension interface
 */
export interface ToolExtension extends Extension {
  type: ExtensionType.TOOL;
  execute: (params: Record<string, any>) => Promise<any>;
  getSchema(): Record<string, any>;
}

/**
 * Extension registry manages all extensions in the system
 */
export class ExtensionRegistry extends EventEmitter {
  private extensions: Map<string, Extension> = new Map();
  private mcpExtensions: Map<string, MCPExtension> = new Map();
  private toolExtensions: Map<string, ToolExtension> = new Map();

  constructor() {
    super();
  }

  /**
   * Register an extension
   */
  async registerExtension(extension: Extension): Promise<void> {
    const id = `${extension.type}:${extension.metadata.name}`;

    if (this.extensions.has(id)) {
      throw new Error(`Extension already registered: ${id}`);
    }

    // Initialize the extension
    await extension.initialize();

    // Store in the general extensions map
    this.extensions.set(id, extension);

    // Store in type-specific maps for quicker access
    switch (extension.type) {
      case ExtensionType.MCP:
        this.mcpExtensions.set(
          extension.metadata.name,
          extension as MCPExtension
        );
        break;
      case ExtensionType.TOOL:
        this.toolExtensions.set(
          extension.metadata.name,
          extension as ToolExtension
        );
        break;
    }

    this.emit('extension:registered', extension);
  }

  /**
   * Unregister an extension
   */
  async unregisterExtension(name: string, type: ExtensionType): Promise<void> {
    const id = `${type}:${name}`;
    const extension = this.extensions.get(id);

    if (!extension) {
      throw new Error(`Extension not found: ${id}`);
    }

    // Teardown the extension
    await extension.teardown();

    // Remove from maps
    this.extensions.delete(id);

    switch (type) {
      case ExtensionType.MCP:
        this.mcpExtensions.delete(name);
        break;
      case ExtensionType.TOOL:
        this.toolExtensions.delete(name);
        break;
    }

    this.emit('extension:unregistered', extension);
  }

  /**
   * Get all extensions of a specific type
   */
  getExtensionsByType(type: ExtensionType): Extension[] {
    return Array.from(this.extensions.values()).filter(
      ext => ext.type === type
    );
  }

  /**
   * Get a specific MCP extension
   */
  getMCPExtension(name: string): MCPExtension | undefined {
    return this.mcpExtensions.get(name);
  }

  /**
   * Get a specific tool extension
   */
  getToolExtension(name: string): ToolExtension | undefined {
    return this.toolExtensions.get(name);
  }

  /**
   * Get all MCP extensions
   */
  getAllMCPExtensions(): MCPExtension[] {
    return Array.from(this.mcpExtensions.values());
  }

  /**
   * Get all tool extensions
   */
  getAllToolExtensions(): ToolExtension[] {
    return Array.from(this.toolExtensions.values());
  }
}

// Create a singleton instance
export const extensionRegistry = new ExtensionRegistry();
