import { EventEmitter } from "events";

import type { MCPExtension, ToolExtension } from "../core/extensions";

import { extensionRegistry, ExtensionType } from "../core/extensions";

/**
 * Tool parameter schema
 */
export interface ToolParameterSchema {
  type: string;
  description?: string;
  required?: boolean;
  enum?: string[];
  items?: ToolParameterSchema;
  properties?: Record<string, ToolParameterSchema>;
}

/**
 * Tool schema describing the tool's functionality and parameters
 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties?: Record<string, ToolParameterSchema>;
    required?: string[];
  };
}

/**
 * Tool execution context
 */
export interface ToolContext {
  userId?: string;
  conversationId?: string;
  requestId?: string;
  [key: string]: any;
}

/**
 * Base tool interface
 */
export interface Tool {
  schema: ToolSchema;
  execute: (params: Record<string, any>, context?: ToolContext) => Promise<any>;
}

/**
 * MCP tool interface for connecting to MCP servers
 */
export interface MCPTool extends Tool {
  serverUrl: string;
  apiKey?: string;
}

/**
 * Configuration for tool registry
 */
export interface ToolRegistryConfig {
  autoDiscoverMCP?: boolean;
  allowDynamicTools?: boolean;
}

/**
 * Tool registry to manage all available tools
 */
export class ToolRegistry extends EventEmitter {
  private tools: Map<string, Tool> = new Map();
  private config: ToolRegistryConfig;

  constructor(config: ToolRegistryConfig = {}) {
    super();
    this.config = {
      autoDiscoverMCP: false,
      allowDynamicTools: true,
      ...config,
    };

    // If auto-discover is enabled, connect extension registry
    if (this.config.autoDiscoverMCP) {
      this.connectExtensionRegistry();
    }
  }

  /**
   * Register a tool in the registry
   */
  registerTool(tool: Tool): void {
    const name = tool.schema.name;
    if (this.tools.has(name)) {
      throw new Error(`Tool already registered: ${name}`);
    }
    this.tools.set(name, tool);
    this.emit("tool:registered", tool);
  }

  /**
   * Get a tool from the registry
   */
  getTool(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return tool;
  }

  /**
   * Check if a tool exists
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Remove a tool from the registry
   */
  removeTool(name: string): void {
    if (!this.tools.has(name)) {
      throw new Error(`Tool not found: ${name}`);
    }
    const tool = this.tools.get(name)!;
    this.tools.delete(name);
    this.emit("tool:removed", tool);
  }

  /**
   * Get all tools
   */
  getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get all tool schemas
   */
  getAllToolSchemas(): ToolSchema[] {
    return this.getAllTools().map((tool) => tool.schema);
  }

  /**
   * Execute a tool
   */
  async executeTool(
    name: string,
    params: Record<string, any>,
    context?: ToolContext,
  ): Promise<any> {
    const tool = this.getTool(name);
    try {
      const result = await tool.execute(params, context);
      this.emit("tool:executed", { name, params, result, success: true });
      return result;
    } catch (error) {
      this.emit("tool:executed", {
        name,
        params,
        error: error instanceof Error ? error.message : String(error),
        success: false,
      });
      throw error;
    }
  }

  /**
   * Connect to the extension registry to auto-discover tools
   */
  private connectExtensionRegistry(): void {
    // Add existing MCP extensions
    extensionRegistry.getAllMCPExtensions().forEach((mcpExt) => {
      this.registerMCPExtensionTools(mcpExt);
    });

    // Add existing tool extensions
    extensionRegistry.getAllToolExtensions().forEach((toolExt) => {
      this.registerToolExtension(toolExt);
    });

    // Listen for new extensions
    extensionRegistry.on("extension:registered", (extension) => {
      if (extension.type === ExtensionType.MCP) {
        this.registerMCPExtensionTools(extension as MCPExtension);
      } else if (extension.type === ExtensionType.TOOL) {
        this.registerToolExtension(extension as ToolExtension);
      }
    });

    // Listen for extension removals
    extensionRegistry.on("extension:unregistered", (extension) => {
      // For MCP extensions, we would need to remove all tools associated with that extension
      if (extension.type === ExtensionType.MCP) {
        const mcpExt = extension as MCPExtension;
        // Assuming tool names are prefixed with the MCP extension name
        const prefix = `${mcpExt.metadata.name}_`;

        // Find and remove all tools with this prefix
        this.getAllTools().forEach((tool) => {
          if (tool.schema.name.startsWith(prefix)) {
            this.removeTool(tool.schema.name);
          }
        });
      } else if (extension.type === ExtensionType.TOOL) {
        // For tool extensions, just remove the single tool
        const toolExt = extension as ToolExtension;
        const toolName = toolExt.metadata.name;
        if (this.hasTool(toolName)) {
          this.removeTool(toolName);
        }
      }
    });
  }

  /**
   * Register tools from an MCP extension
   */
  private async registerMCPExtensionTools(
    mcpExtension: MCPExtension,
  ): Promise<void> {
    try {
      const toolDefinitions = await mcpExtension.getToolDefinitions();

      toolDefinitions.forEach((def) => {
        // Create an MCP tool adapter
        const mcpTool: MCPTool = {
          schema: {
            name: `mcp_${mcpExtension.metadata.name}_${def.name}`,
            description: def.description,
            parameters: def.parameters,
          },
          serverUrl: mcpExtension.config.serverUrl,
          apiKey: mcpExtension.config.apiKey,
          execute: async (params, context) => {
            // Implement MCP tool execution logic here
            // This would make a request to the MCP server with the tool name and params
            const response = await fetch(
              `${mcpExtension.config.serverUrl}/v1/tools/${def.name}`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(mcpExtension.config.apiKey
                    ? { Authorization: `Bearer ${mcpExtension.config.apiKey}` }
                    : {}),
                },
                body: JSON.stringify({ params, context }),
              },
            );

            if (!response.ok) {
              throw new Error(
                `MCP tool execution failed: ${response.statusText}`,
              );
            }

            return await response.json();
          },
        };

        this.registerTool(mcpTool);
      });
    } catch (error) {
      console.error(
        `Failed to register MCP extension tools for ${mcpExtension.metadata.name}:`,
        error,
      );
      this.emit("mcp:registration-failed", { extension: mcpExtension, error });
    }
  }

  /**
   * Register a tool extension
   */
  private registerToolExtension(toolExtension: ToolExtension): void {
    try {
      const tool: Tool = {
        schema: {
          name: toolExtension.metadata.name,
          description: toolExtension.metadata.description,
          parameters: {
            type: "object",
            ...toolExtension.getSchema(),
          },
        },
        execute: async (params, context) => {
          return await toolExtension.execute(params);
        },
      };

      this.registerTool(tool);
    } catch (error) {
      console.error(
        `Failed to register tool extension ${toolExtension.metadata.name}:`,
        error,
      );
      this.emit("tool-extension:registration-failed", {
        extension: toolExtension,
        error,
      });
    }
  }
}

// Create a singleton instance with default configuration
export const toolRegistry = new ToolRegistry();

/**
 * Create a simple tool with an execute function
 */
export function createTool(
  schema: ToolSchema,
  executeFn: (
    params: Record<string, any>,
    context?: ToolContext,
  ) => Promise<any>,
): Tool {
  return {
    schema,
    execute: executeFn,
  };
}

/**
 * Create an MCP tool
 */
export function createMCPTool(
  schema: ToolSchema,
  serverUrl: string,
  apiKey?: string,
): MCPTool {
  return {
    schema,
    serverUrl,
    apiKey,
    execute: async (params, context) => {
      const response = await fetch(`${serverUrl}/v1/tools/${schema.name}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ params, context }),
      });

      if (!response.ok) {
        throw new Error(`MCP tool execution failed: ${response.statusText}`);
      }

      return await response.json();
    },
  };
}
