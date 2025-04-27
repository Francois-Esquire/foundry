import type { ExtensionMetadata, ToolExtension } from "../../core/extensions";

import { extensionRegistry, ExtensionType } from "../../core/extensions";
import { toolRegistry } from "../tools";

/**
 * Example of a custom tool extension that provides a calculator functionality
 */
export class CalculatorToolExtension implements ToolExtension {
  type: ExtensionType.TOOL = ExtensionType.TOOL;

  metadata: ExtensionMetadata = {
    name: "calculator",
    description:
      "A simple calculator tool for performing basic math operations",
    version: "1.0.0",
    author: "Foundry",
  };

  async initialize(): Promise<void> {
    console.log("Calculator tool extension initialized");
  }

  async teardown(): Promise<void> {
    console.log("Calculator tool extension terminated");
  }

  getSchema(): Record<string, any> {
    return {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description:
            "The operation to perform (add, subtract, multiply, divide)",
          enum: ["add", "subtract", "multiply", "divide"],
        },
        a: {
          type: "number",
          description: "First operand",
        },
        b: {
          type: "number",
          description: "Second operand",
        },
      },
      required: ["operation", "a", "b"],
    };
  }

  async execute(params: Record<string, any>): Promise<any> {
    const { operation, a, b } = params;

    switch (operation) {
      case "add":
        return { result: a + b };
      case "subtract":
        return { result: a - b };
      case "multiply":
        return { result: a * b };
      case "divide":
        if (b === 0) {
          throw new Error("Division by zero is not allowed");
        }
        return { result: a / b };
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }
}

/**
 * Example usage
 */
export async function demonstrateCalculatorTool() {
  // Create and register the calculator extension
  const calculatorExtension = new CalculatorToolExtension();
  await extensionRegistry.registerExtension(calculatorExtension);

  // Configure the tool registry to auto-discover extensions
  const autoDiscoverConfig = { autoDiscoverMCP: true };

  // If the registry wasn't already configured with autoDiscoverMCP,
  // we would need to create a new registry with this config
  console.log("Tool registry configuration:", autoDiscoverConfig);

  // Example: verify the tool is registered
  if (toolRegistry.hasTool("calculator")) {
    const params = {
      operation: "multiply",
      a: 5,
      b: 10,
    };

    // Execute the tool
    try {
      const result = await toolRegistry.executeTool("calculator", params);
      console.log("Calculator result:", result);
    } catch (error) {
      console.error("Error executing calculator tool:", error);
    }
  } else {
    console.warn("Calculator tool was not properly registered");
  }
}
