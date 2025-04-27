import type { Provider } from "ai";

import { beforeEach, describe, expect, jest, spyOn, test } from "bun:test";

import type { AgentConfig } from "../../src/agents/agents";
import type { Extension, ExtensionMetadata } from "../../src/core/extensions";

import { Agent } from "../../src/agents/agents";
import { ToolRegistry } from "../../src/agents/tools";
import { WorkflowManager } from "../../src/agents/workflows";
import { ExtensionType } from "../../src/core/extensions";

// --- Mocks ---

// Mock ToolRegistry Module
const mockToolRegistryInstance = {
  registerTool: jest.fn(),
  executeTool: jest.fn(),
  hasTool: jest.fn(),
  getAllToolSchemas: jest.fn(() => []),
};

// Mock WorkflowManager Module
const mockWorkflowManagerInstance = {
  createWorkflow: jest.fn(),
  runWorkflow: jest.fn(),
  cancelWorkflow: jest.fn(),
  getWorkflow: jest.fn(),
};
jest.mock("../../src/agents/workflows", () => ({
  WorkflowManager: jest
    .fn()
    .mockImplementation(() => mockWorkflowManagerInstance),
}));

// Mock extensionRegistry singleton
const mockRegisterExtension = jest.fn();

// More robust Mock AI Provider - Cast to satisfy config type
const mockProvider = {
  // Add methods likely expected by AI SDK integrations if needed
  generateText: jest.fn(),
  generateObject: jest.fn(),
  // Add chat, streamText, etc. if potentially used by Agent/Workflows
} as unknown as Provider; // Assert type carefully

// Mock Extension
class MockExtension implements Extension {
  type: ExtensionType = ExtensionType.TOOL;
  metadata: ExtensionMetadata = {
    name: "mock-extension",
    description: "A mock extension",
    version: "1.0.0",
  };
  initialize = jest.fn(() => Promise.resolve());
  teardown = jest.fn(() => Promise.resolve());
}

describe("Agent", () => {
  let agent: Agent;
  let config: AgentConfig;

  beforeEach(() => {
    // Clear all mocks defined via jest.fn()
    jest.clearAllMocks();

    // Manually clear mocks on the instance objects too
    mockToolRegistryInstance.registerTool.mockClear();
    mockToolRegistryInstance.executeTool.mockClear();
    mockToolRegistryInstance.hasTool.mockClear();
    mockToolRegistryInstance.getAllToolSchemas.mockClear();
    mockWorkflowManagerInstance.createWorkflow.mockClear();
    mockWorkflowManagerInstance.runWorkflow.mockClear();
    mockWorkflowManagerInstance.cancelWorkflow.mockClear();
    mockWorkflowManagerInstance.getWorkflow.mockClear();
    mockRegisterExtension.mockClear();
    (mockProvider.generateText as jest.Mock)?.mockClear();
    (mockProvider.generateObject as jest.Mock)?.mockClear();

    // Default config
    config = {
      name: "Test Agent",
      description: "An agent for testing",
    };

    // Instantiate agent
    agent = new Agent(config);

    // Verify constructors were called
    expect(ToolRegistry).toHaveBeenCalledTimes(1);
    expect(WorkflowManager).toHaveBeenCalledTimes(1);
  });

  test("should instantiate correctly with basic config", () => {
    expect(agent.name).toBe("Test Agent");
    expect(agent.description).toBe("An agent for testing");
    expect(agent.toolRegistry).toBe(mockToolRegistryInstance);
    expect(agent.workflowManager).toBe(mockWorkflowManagerInstance);
    expect(agent.extensionRegistry).toBeDefined();
    expect(agent.getProvider()).toBeUndefined();
    expect(mockRegisterExtension).not.toHaveBeenCalled();
  });

  test("should instantiate with provider", () => {
    const agentWithProvider = new Agent({ ...config, provider: mockProvider });
    expect(agentWithProvider.getProvider()).toBe(mockProvider);
  });

  test("should instantiate with extensions and attempt registration", async () => {
    const ext1 = new MockExtension();
    const ext2 = new MockExtension();
    ext2.metadata.name = "mock-extension-2";

    const agentWithExtensions = new Agent({
      ...config,
      extensions: [ext1, ext2],
    });
    expect(agentWithExtensions).toBeDefined(); // Use variable

    // Allow async registration logic to proceed
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockRegisterExtension).toHaveBeenCalledTimes(2);
    expect(mockRegisterExtension).toHaveBeenCalledWith(ext1);
    expect(mockRegisterExtension).toHaveBeenCalledWith(ext2);
  });

  test("should instantiate ToolRegistry with specific config", () => {
    const toolConfig = { autoDiscoverMCP: true };
    agent = new Agent({ ...config, toolRegistryConfig: toolConfig }); // Re-instantiate
    expect(ToolRegistry).toHaveBeenCalledWith(toolConfig);
  });

  test("setProvider should update the provider", () => {
    expect(agent.getProvider()).toBeUndefined();
    agent.setProvider(mockProvider);
    expect(agent.getProvider()).toBe(mockProvider);
  });

  test("registerTool should delegate to ToolRegistry", () => {
    const mockTool: any = { schema: { name: "test-tool" }, execute: jest.fn() };
    agent.registerTool(mockTool);
    expect(mockToolRegistryInstance.registerTool).toHaveBeenCalledTimes(1);
    expect(mockToolRegistryInstance.registerTool).toHaveBeenCalledWith(
      mockTool,
    );
  });

  test("executeTool should delegate to ToolRegistry if tool exists", async () => {
    const toolName = "existing-tool";
    const params = { a: 1 };
    const context = { b: 2 };
    mockToolRegistryInstance.hasTool.mockReturnValue(true);
    mockToolRegistryInstance.executeTool.mockResolvedValue({
      result: "success",
    });

    await agent.executeTool(toolName, params, context);

    expect(mockToolRegistryInstance.hasTool).toHaveBeenCalledWith(toolName);
    expect(mockToolRegistryInstance.executeTool).toHaveBeenCalledTimes(1);
    expect(mockToolRegistryInstance.executeTool).toHaveBeenCalledWith(
      toolName,
      params,
      context,
    );
  });

  test("executeTool should throw if tool does not exist", async () => {
    const toolName = "non-existing-tool";
    mockToolRegistryInstance.hasTool.mockReturnValue(false);

    await expect(agent.executeTool(toolName, {})).rejects.toThrow(
      `Tool '${toolName}' not registered or available for agent '${agent.name}'`,
    );
    expect(mockToolRegistryInstance.executeTool).not.toHaveBeenCalled();
  });

  test("getAvailableToolSchemas should delegate to ToolRegistry", () => {
    agent.getAvailableToolSchemas();
    expect(mockToolRegistryInstance.getAllToolSchemas).toHaveBeenCalledTimes(1);
  });

  test("createWorkflow should delegate to WorkflowManager", () => {
    const steps: any[] = [jest.fn()];
    const context = { c: 3 };
    const options = { name: "MyWorkflow" };
    agent.createWorkflow(steps, context, options);
    expect(mockWorkflowManagerInstance.createWorkflow).toHaveBeenCalledTimes(1);
    expect(mockWorkflowManagerInstance.createWorkflow).toHaveBeenCalledWith(
      steps,
      context,
      options,
    );
  });

  test("runWorkflow should delegate to WorkflowManager", () => {
    const workflowId = "wf-123";
    const options = { callbacks: {} };
    agent.runWorkflow(workflowId, options);
    expect(mockWorkflowManagerInstance.runWorkflow).toHaveBeenCalledTimes(1);
    expect(mockWorkflowManagerInstance.runWorkflow).toHaveBeenCalledWith(
      workflowId,
      options,
    );
  });

  test("cancelWorkflow should delegate to WorkflowManager", () => {
    const workflowId = "wf-123";
    agent.cancelWorkflow(workflowId);
    expect(mockWorkflowManagerInstance.cancelWorkflow).toHaveBeenCalledTimes(1);
    expect(mockWorkflowManagerInstance.cancelWorkflow).toHaveBeenCalledWith(
      workflowId,
    );
  });

  test("getWorkflow should delegate to WorkflowManager", () => {
    const workflowId = "wf-123";
    agent.getWorkflow(workflowId);
    expect(mockWorkflowManagerInstance.getWorkflow).toHaveBeenCalledTimes(1);
    expect(mockWorkflowManagerInstance.getWorkflow).toHaveBeenCalledWith(
      workflowId,
    );
  });

  test("destroy should log a message", async () => {
    const consoleSpy = spyOn(console, "log");
    await agent.destroy();
    expect(consoleSpy).toHaveBeenCalledWith(`Destroying agent: ${agent.name}`);
    consoleSpy.mockRestore(); // Clean up spy
  });
});
