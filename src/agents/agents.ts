import type { Provider } from "ai";

import type { Extension } from "../core/extensions";
import type {
  Tool,
  ToolContext,
  ToolRegistryConfig,
  ToolSchema,
} from "./tools";
import type {
  RunWorkflowOptions,
  RunWorkflowResult,
  Workflow,
  WorkflowContext,
  WorkflowStepFunction,
} from "./workflows";

import { extensionRegistry } from "../core/extensions";
import { ToolRegistry } from "./tools";
import { WorkflowManager } from "./workflows";

export interface AgentConfig {
  name: string;
  description?: string;
  provider?: Provider; // The AI provider (optional, might be configured later)
  extensions?: Extension[]; // Extensions to load
  toolRegistryConfig?: ToolRegistryConfig; // Configuration for the tool registry
}

export class Agent {
  public readonly name: string;
  public readonly description?: string;
  private provider?: Provider;

  // Integrated components
  public readonly toolRegistry: ToolRegistry;
  public readonly workflowManager: WorkflowManager;
  public readonly extensionRegistry: typeof extensionRegistry; // Use the singleton instance

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.description = config.description;
    this.provider = config.provider;

    // Initialize registries
    this.toolRegistry = new ToolRegistry(config.toolRegistryConfig);
    this.workflowManager = new WorkflowManager();
    this.extensionRegistry = extensionRegistry; // Referencing the singleton

    // Register extensions passed in the configuration
    if (config.extensions) {
      this.registerExtensions(config.extensions);
    }
  }

  /**
   * Asynchronously registers a list of extensions.
   */
  private async registerExtensions(extensions: Extension[]): Promise<void> {
    for (const extension of extensions) {
      try {
        await this.extensionRegistry.registerExtension(extension);
        console.log(
          `Successfully registered extension: ${extension.metadata.name}`,
        );
      } catch (error) {
        console.error(
          `Failed to register extension ${extension.metadata.name}:`,
          error,
        );
      }
    }
  }

  /**
   * Set or change the AI provider for this agent.
   */
  setProvider(provider: Provider): void {
    this.provider = provider;
  }

  /**
   * Get the currently configured AI provider.
   */
  getProvider(): Provider | undefined {
    return this.provider;
  }

  // --- Tool Management ---

  /**
   * Registers a tool directly with this agent's tool registry.
   */
  registerTool(tool: Tool): void {
    this.toolRegistry.registerTool(tool);
  }

  /**
   * Executes a tool registered with this agent.
   */
  executeTool(
    name: string,
    params: Record<string, any>,
    context?: ToolContext,
  ): Promise<any> {
    if (!this.toolRegistry.hasTool(name)) {
      throw new Error(
        `Tool '${name}' not registered or available for agent '${this.name}'`,
      );
    }
    return this.toolRegistry.executeTool(name, params, context);
  }

  /**
   * Gets all tool schemas available to this agent.
   */
  getAvailableToolSchemas(): ToolSchema[] {
    return this.toolRegistry.getAllToolSchemas();
  }

  // --- Workflow Management ---

  /**
   * Creates a new workflow associated with this agent.
   */
  createWorkflow(
    steps: WorkflowStepFunction[],
    initialContext: WorkflowContext = {},
    options?: { name?: string },
  ): Workflow {
    return this.workflowManager.createWorkflow(steps, initialContext, options);
  }

  /**
   * Runs a workflow by its ID.
   */
  runWorkflow(
    workflowId: string,
    options?: RunWorkflowOptions,
  ): RunWorkflowResult {
    return this.workflowManager.runWorkflow(workflowId, options);
  }

  /**
   * Cancels a running or pending workflow.
   */
  cancelWorkflow(workflowId: string): Promise<boolean> {
    return this.workflowManager.cancelWorkflow(workflowId);
  }

  /**
   * Retrieves a workflow by its ID.
   */
  getWorkflow(workflowId: string): Workflow | undefined {
    return this.workflowManager.getWorkflow(workflowId);
  }

  // --- Agent Lifecycle ---

  /**
   * Performs any necessary cleanup when the agent is no longer needed.
   */
  async destroy(): Promise<void> {
    console.log(`Destroying agent: ${this.name}`);
  }
}
