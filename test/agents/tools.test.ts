import { describe, test, expect, beforeEach, mock, jest } from 'bun:test';
import {
  ToolRegistry,
  Tool,
  ToolSchema,
  ToolContext,
  createTool,
  createMCPTool,
} from '../../src/agents/tools';
import { ExtensionType, extensionRegistry } from '../../src/core/extensions';
import type {
  ToolExtension,
  MCPExtension,
  ExtensionMetadata,
  MCPExtensionConfig,
} from '../../src/core/extensions';

// Mock global fetch
// @ts-expect-error Mock implementation
global.fetch = jest.fn();

// Setup test data
const testToolSchema: ToolSchema = {
  name: 'test-tool',
  description: 'A test tool for unit tests',
  parameters: {
    type: 'object',
    properties: {
      param1: {
        type: 'string',
        description: 'Parameter 1',
      },
      param2: {
        type: 'number',
        description: 'Parameter 2',
      },
    },
    required: ['param1'],
  },
};

const testMcpToolSchema: ToolSchema = {
  name: 'mcp-tool',
  description: 'An MCP tool for unit tests',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Resource ID',
      },
    },
    required: ['id'],
  },
};

// Mock Tool Extension
class TestToolExtension implements ToolExtension {
  type: ExtensionType.TOOL = ExtensionType.TOOL;
  metadata: ExtensionMetadata = {
    name: 'test-extension-tool',
    description: 'Tool extension for testing',
    version: '1.0.0',
  };

  initialize = mock(() => Promise.resolve());
  teardown = mock(() => Promise.resolve());
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  execute = mock((_params: Record<string, any>) =>
    Promise.resolve({ extensionResult: 'success' })
  );
  getSchema = mock(() => ({
    type: 'object',
    properties: {
      extensionParam: { type: 'string' },
    },
    required: ['extensionParam'],
  }));
}

// Mock MCP Extension
class TestMCPExtension implements MCPExtension {
  type: ExtensionType.MCP = ExtensionType.MCP;
  metadata: ExtensionMetadata = {
    name: 'test-mcp',
    description: 'MCP extension for testing',
    version: '1.0.0',
  };
  config: MCPExtensionConfig = {
    serverUrl: 'https://test-mcp.com/api',
    apiKey: 'test-key',
    tools: ['mcp_tool1', 'mcp_tool2'],
  };

  initialize = mock(() => Promise.resolve());
  teardown = mock(() => Promise.resolve());
  getToolDefinitions = mock(() =>
    Promise.resolve([
      {
        name: 'mcp_tool1',
        description: 'MCP Tool 1',
        parameters: {
          type: 'object',
          properties: {
            mcpParam1: { type: 'string' },
          },
        },
      },
      {
        name: 'mcp_tool2',
        description: 'MCP Tool 2',
        parameters: {
          type: 'object',
          properties: {
            mcpParam2: { type: 'number' },
          },
        },
      },
    ])
  );
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    registry = new ToolRegistry();
    mockFetch = fetch as jest.Mock;
    mockFetch.mockClear();
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: 'test-response' }),
      })
    );
  });

  test('should register and retrieve a tool', () => {
    const executeFn = mock(() => Promise.resolve({ result: 'success' }));
    const tool = createTool(testToolSchema, executeFn);

    registry.registerTool(tool);

    expect(registry.hasTool('test-tool')).toBe(true);
    expect(registry.getTool('test-tool')).toBe(tool);
    expect(registry.getAllTools().length).toBe(1);
    expect(registry.getAllToolSchemas()[0]).toBe(testToolSchema);
  });

  test('should throw when registering a tool with an existing name', () => {
    const tool1 = createTool(testToolSchema, () => Promise.resolve({}));
    const tool2 = createTool(testToolSchema, () => Promise.resolve({}));

    registry.registerTool(tool1);

    expect(() => registry.registerTool(tool2)).toThrow(
      'Tool already registered'
    );
  });

  test('should throw when retrieving a non-existent tool', () => {
    expect(() => registry.getTool('non-existent')).toThrow('Tool not found');
  });

  test('should remove a tool', () => {
    const tool = createTool(testToolSchema, () => Promise.resolve({}));
    registry.registerTool(tool);

    registry.removeTool('test-tool');

    expect(registry.hasTool('test-tool')).toBe(false);
    expect(registry.getAllTools().length).toBe(0);
  });

  test('should throw when removing a non-existent tool', () => {
    expect(() => registry.removeTool('non-existent')).toThrow('Tool not found');
  });

  test('should execute a tool', async () => {
    const executeFn = mock(() => Promise.resolve({ result: 'success' }));
    const tool = createTool(testToolSchema, executeFn);
    registry.registerTool(tool);

    const params = { param1: 'value1', param2: 42 };
    const context: ToolContext = { userId: 'user123' };

    await registry.executeTool('test-tool', params, context);

    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(executeFn).toHaveBeenCalledWith(params, context);
  });

  test('should emit events when registering, executing, and removing tools', async () => {
    const registerHandler = mock();
    const executeHandler = mock();
    const removeHandler = mock();

    registry.on('tool:registered', registerHandler);
    registry.on('tool:executed', executeHandler);
    registry.on('tool:removed', removeHandler);

    const executeFn = mock(() => Promise.resolve({ result: 'success' }));
    const tool = createTool(testToolSchema, executeFn);

    registry.registerTool(tool);
    await registry.executeTool('test-tool', { param1: 'test' });
    registry.removeTool('test-tool');

    expect(registerHandler).toHaveBeenCalledTimes(1);
    expect(registerHandler).toHaveBeenCalledWith(tool);

    expect(executeHandler).toHaveBeenCalledTimes(1);
    expect(executeHandler.mock.calls[0]![0].name).toBe('test-tool');
    expect(executeHandler.mock.calls[0]![0].success).toBe(true);

    expect(removeHandler).toHaveBeenCalledTimes(1);
    expect(removeHandler).toHaveBeenCalledWith(tool);
  });

  test('should emit error event when tool execution fails', async () => {
    const executeHandler = mock();
    registry.on('tool:executed', executeHandler);

    const error = new Error('Test error');
    const executeFn = mock(() => Promise.reject(error));
    const tool = createTool(testToolSchema, executeFn);

    registry.registerTool(tool);

    await expect(
      registry.executeTool('test-tool', { param1: 'test' })
    ).rejects.toThrow('Test error');

    expect(executeHandler).toHaveBeenCalledTimes(1);
    expect(executeHandler.mock.calls[0][0].success).toBe(false);
    expect(executeHandler.mock.calls[0][0].error).toBe('Test error');
  });
});

describe('ToolRegistry with Extension integration', () => {
  let registry: ToolRegistry;
  let toolExtension: TestToolExtension;
  let mcpExtension: TestMCPExtension;
  let mockFetch: jest.Mock;

  beforeEach(async () => {
    // Create a fresh extension registry to avoid side effects
    // We'll use a fresh registry with auto-discover enabled
    registry = new ToolRegistry({ autoDiscoverMCP: true });

    // Create and register mock extensions
    toolExtension = new TestToolExtension();
    mcpExtension = new TestMCPExtension();

    mockFetch = fetch as jest.Mock;
    mockFetch.mockClear();
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: 'test-response' }),
      })
    );

    // Register extensions
    await extensionRegistry.registerExtension(toolExtension);
    await extensionRegistry.registerExtension(mcpExtension);
  });

  test('should register tool extensions automatically', () => {
    expect(registry.hasTool('test-extension-tool')).toBe(true);

    const toolSchema = registry.getTool('test-extension-tool').schema;
    expect(toolSchema.name).toBe('test-extension-tool');
  });

  test('should register MCP tools automatically', () => {
    const expectedToolNames = [
      'mcp_test-mcp_mcp_tool1',
      'mcp_test-mcp_mcp_tool2',
    ];

    for (const name of expectedToolNames) {
      expect(registry.hasTool(name)).toBe(true);
    }
  });

  test('should execute a tool from a tool extension', async () => {
    const result = await registry.executeTool('test-extension-tool', {
      extensionParam: 'test',
    });

    expect(toolExtension.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ extensionResult: 'success' });
  });

  test('should execute an MCP tool', async () => {
    await registry.executeTool('mcp_test-mcp_mcp_tool1', { mcpParam1: 'test' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toBe(
      'https://test-mcp.com/api/v1/tools/mcp_tool1'
    );
    expect(mockFetch.mock.calls[0]![1].method).toBe('POST');
    expect(mockFetch.mock.calls[0]![1].headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-key',
    });
  });
});

describe('createTool', () => {
  test('should create a tool with the correct schema and execute function', async () => {
    const executeFn = mock(() => Promise.resolve({ result: 'success' }));
    const tool = createTool(testToolSchema, executeFn);

    expect(tool.schema).toBe(testToolSchema);

    const params = { param1: 'test', param2: 42 };
    const context = { userId: 'user123' };
    const result = await tool.execute(params, context);

    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(executeFn).toHaveBeenCalledWith(params, context);
    expect(result).toEqual({ result: 'success' });
  });
});

describe('createMCPTool', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = fetch as jest.Mock;
    mockFetch.mockClear();
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: 'test-response' }),
      })
    );
  });

  test('should create an MCP tool with the correct schema and execute function', async () => {
    const serverUrl = 'https://mcp-server.example.com/api';
    const apiKey = 'test-api-key';
    const tool = createMCPTool(testMcpToolSchema, serverUrl, apiKey);

    expect(tool.schema).toBe(testMcpToolSchema);
    expect(tool.serverUrl).toBe(serverUrl);
    expect(tool.apiKey).toBe(apiKey);

    const params = { id: 'resource-123' };
    const context = { userId: 'user123' };
    const result = await tool.execute(params, context);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(
      `${serverUrl}/v1/tools/${testMcpToolSchema.name}`
    );
    expect(mockFetch.mock.calls[0][1].method).toBe('POST');
    expect(mockFetch.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-api-key',
    });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      params,
      context,
    });
    expect(result).toEqual({ success: true, data: 'test-response' });
  });

  test('should handle MCP tool execution error', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        statusText: 'Bad Request',
      })
    );

    const tool = createMCPTool(testMcpToolSchema, 'https://example.com', 'key');

    await expect(tool.execute({ id: 'test' })).rejects.toThrow(
      'MCP tool execution failed: Bad Request'
    );
  });
});
