import { ExtensionType, extensionRegistry } from '../../core/extensions';
import type {
  ExtensionMetadata,
  MCPExtension,
  MCPExtensionConfig,
} from '../../core/extensions';
import { toolRegistry } from '../tools';

/**
 * Example of an MCP extension that connects to a hypothetical MCP server
 */
export class ExampleMCPExtension implements MCPExtension {
  type: ExtensionType.MCP = ExtensionType.MCP;

  metadata: ExtensionMetadata = {
    name: 'example-mcp',
    description: 'Example MCP extension connecting to a task-master server',
    version: '1.0.0',
    author: 'Foundry',
  };

  config: MCPExtensionConfig = {
    serverUrl: 'https://example-mcp-server.com/api',
    apiKey: 'fake-api-key-12345',
    tools: [
      'task-master_get_tasks',
      'task-master_add_task',
      'task-master_next_task',
    ],
  };

  async initialize(): Promise<void> {
    console.log(`Initializing MCP extension: ${this.metadata.name}`);
    // In a real implementation, this might perform a handshake with the MCP server
    // or validate credentials
  }

  async teardown(): Promise<void> {
    console.log(`Shutting down MCP extension: ${this.metadata.name}`);
    // Cleanup any resources, close connections, etc.
  }

  /**
   * Retrieve tool definitions from the MCP server
   */
  async getToolDefinitions(): Promise<any[]> {
    // In a real implementation, this would make an API call to the MCP server
    // to retrieve the available tools and their schemas
    console.log(`Fetching tool definitions from ${this.config.serverUrl}`);

    // This is a mock implementation that returns hardcoded tool definitions
    // that would normally come from the server
    return [
      {
        name: 'task-master_get_tasks',
        description:
          'Get all tasks from Task Master, optionally filtering by status.',
        parameters: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              description: 'Filter tasks by status (e.g., "pending", "done")',
            },
            withSubtasks: {
              type: 'boolean',
              description: 'Include subtasks in the response',
            },
            projectRoot: {
              type: 'string',
              description:
                'The directory of the project. Must be an absolute path.',
            },
          },
          required: ['projectRoot'],
        },
      },
      {
        name: 'task-master_add_task',
        description: 'Add a new task using AI',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'Description of the task to add',
            },
            dependencies: {
              type: 'string',
              description:
                'Comma-separated list of task IDs this task depends on',
            },
            priority: {
              type: 'string',
              description: 'Task priority (high, medium, low)',
            },
            projectRoot: {
              type: 'string',
              description:
                'The directory of the project. Must be an absolute path.',
            },
          },
          required: ['projectRoot', 'prompt'],
        },
      },
    ];
  }
}

/**
 * Example usage
 */
export async function demonstrateMCPExtension() {
  // Create and register the MCP extension
  const mcpExtension = new ExampleMCPExtension();
  await extensionRegistry.registerExtension(mcpExtension);

  // Configure the tool registry to auto-discover extensions
  const autoDiscoverConfig = { autoDiscoverMCP: true };

  // Recreate registry with config that enables MCP autodiscovery
  console.log('Tool registry configuration:', autoDiscoverConfig);

  // Check if MCP tools were registered
  const expectedTools = [
    'mcp_example-mcp_task-master_get_tasks',
    'mcp_example-mcp_task-master_add_task',
  ];

  for (const toolName of expectedTools) {
    if (toolRegistry.hasTool(toolName)) {
      console.log(`MCP tool registered: ${toolName}`);
    } else {
      console.warn(`MCP tool not registered: ${toolName}`);
    }
  }

  // Example: Execute an MCP tool
  try {
    const result = await toolRegistry.executeTool(
      'mcp_example-mcp_task-master_get_tasks',
      {
        projectRoot: '/Users/example/projects/my-project',
        status: 'pending',
      }
    );
    console.log('MCP tool execution result:', result);
  } catch (error) {
    console.error('Error executing MCP tool:', error);
  }
}
