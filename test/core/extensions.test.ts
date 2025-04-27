import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ExtensionType, ExtensionRegistry } from '../../src/core/extensions';
import type {
  ExtensionMetadata,
  MCPExtension,
  ToolExtension,
  MCPExtensionConfig,
} from '../../src/core/extensions';

// Test implementation of a Tool extension
class TestToolExtension implements ToolExtension {
  type: ExtensionType.TOOL = ExtensionType.TOOL;
  metadata: ExtensionMetadata = {
    name: 'test-tool',
    description: 'Test tool for unit tests',
    version: '1.0.0',
    author: 'Test Author',
  };

  initialize = mock(() => Promise.resolve());
  teardown = mock(() => Promise.resolve());
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  execute = mock((_params: Record<string, any>) =>
    Promise.resolve({ result: 'success' })
  );
  getSchema = mock(() => ({
    type: 'object',
    properties: {
      test: { type: 'string', description: 'Test parameter' },
    },
    required: ['test'],
  }));
}

// Test implementation of an MCP extension
class TestMCPExtension implements MCPExtension {
  type: ExtensionType.MCP = ExtensionType.MCP;
  metadata: ExtensionMetadata = {
    name: 'test-mcp',
    description: 'Test MCP for unit tests',
    version: '1.0.0',
    author: 'Test Author',
  };
  config: MCPExtensionConfig = {
    serverUrl: 'https://test-mcp-server.com/api',
    apiKey: 'test-api-key',
    tools: ['tool1', 'tool2'],
  };

  initialize = mock(() => Promise.resolve());
  teardown = mock(() => Promise.resolve());
  getToolDefinitions = mock(() =>
    Promise.resolve([
      {
        name: 'tool1',
        description: 'Tool 1 for testing',
        parameters: {
          type: 'object',
          properties: { param1: { type: 'string' } },
        },
      },
      {
        name: 'tool2',
        description: 'Tool 2 for testing',
        parameters: {
          type: 'object',
          properties: { param2: { type: 'number' } },
        },
      },
    ])
  );
}

describe('ExtensionRegistry', () => {
  let registry: ExtensionRegistry;
  let toolExtension: TestToolExtension;
  let mcpExtension: TestMCPExtension;

  beforeEach(() => {
    registry = new ExtensionRegistry();
    toolExtension = new TestToolExtension();
    mcpExtension = new TestMCPExtension();

    // Reset mocks
    toolExtension.initialize.mockClear();
    toolExtension.teardown.mockClear();
    toolExtension.execute.mockClear();
    toolExtension.getSchema.mockClear();

    mcpExtension.initialize.mockClear();
    mcpExtension.teardown.mockClear();
    mcpExtension.getToolDefinitions.mockClear();
  });

  test('should register a tool extension', async () => {
    await registry.registerExtension(toolExtension);

    expect(toolExtension.initialize).toHaveBeenCalledTimes(1);
    expect(registry.getToolExtension('test-tool')).toBe(toolExtension);
    expect(registry.getAllToolExtensions().length).toBe(1);
    expect(registry.getExtensionsByType(ExtensionType.TOOL).length).toBe(1);
  });

  test('should register an MCP extension', async () => {
    await registry.registerExtension(mcpExtension);

    expect(mcpExtension.initialize).toHaveBeenCalledTimes(1);
    expect(registry.getMCPExtension('test-mcp')).toBe(mcpExtension);
    expect(registry.getAllMCPExtensions().length).toBe(1);
    expect(registry.getExtensionsByType(ExtensionType.MCP).length).toBe(1);
  });

  test('should not register an extension with the same ID twice', async () => {
    await registry.registerExtension(toolExtension);

    // Attempt to register the same extension again
    await expect(registry.registerExtension(toolExtension)).rejects.toThrow(
      'Extension already registered'
    );
  });

  test('should unregister a tool extension', async () => {
    await registry.registerExtension(toolExtension);
    await registry.unregisterExtension('test-tool', ExtensionType.TOOL);

    expect(toolExtension.teardown).toHaveBeenCalledTimes(1);
    expect(registry.getToolExtension('test-tool')).toBeUndefined();
    expect(registry.getAllToolExtensions().length).toBe(0);
  });

  test('should unregister an MCP extension', async () => {
    await registry.registerExtension(mcpExtension);
    await registry.unregisterExtension('test-mcp', ExtensionType.MCP);

    expect(mcpExtension.teardown).toHaveBeenCalledTimes(1);
    expect(registry.getMCPExtension('test-mcp')).toBeUndefined();
    expect(registry.getAllMCPExtensions().length).toBe(0);
  });

  test('should throw when unregistering a non-existent extension', async () => {
    await expect(
      registry.unregisterExtension('non-existent', ExtensionType.TOOL)
    ).rejects.toThrow('Extension not found');
  });

  test('should emit events when registering and unregistering extensions', async () => {
    const registeredHandler = mock();
    const unregisteredHandler = mock();

    registry.on('extension:registered', registeredHandler);
    registry.on('extension:unregistered', unregisteredHandler);

    await registry.registerExtension(toolExtension);
    await registry.unregisterExtension('test-tool', ExtensionType.TOOL);

    expect(registeredHandler).toHaveBeenCalledTimes(1);
    expect(registeredHandler).toHaveBeenCalledWith(toolExtension);

    expect(unregisteredHandler).toHaveBeenCalledTimes(1);
    expect(unregisteredHandler).toHaveBeenCalledWith(toolExtension);
  });

  test('should get extensions by type', async () => {
    await registry.registerExtension(toolExtension);
    await registry.registerExtension(mcpExtension);

    const toolExtensions = registry.getExtensionsByType(ExtensionType.TOOL);
    const mcpExtensions = registry.getExtensionsByType(ExtensionType.MCP);
    const adapterExtensions = registry.getExtensionsByType(
      ExtensionType.ADAPTER
    );

    expect(toolExtensions.length).toBe(1);
    expect(toolExtensions[0]).toBe(toolExtension);

    expect(mcpExtensions.length).toBe(1);
    expect(mcpExtensions[0]).toBe(mcpExtension);

    expect(adapterExtensions.length).toBe(0);
  });
});
