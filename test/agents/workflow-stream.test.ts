import { PassThrough, Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { WorkflowStepFunction } from "../../src/agents/workflows";

import { WorkflowManager } from "../../src/agents/workflows";

describe("Workflow Streaming", () => {
  let manager: WorkflowManager;
  let collectedData: any[] = [];
  let mockDestination: PassThrough;

  beforeEach(() => {
    manager = new WorkflowManager();
    collectedData = [];

    // Create a PassThrough stream that collects data for testing
    mockDestination = new PassThrough({ objectMode: true });
    mockDestination.on("data", (chunk) => {
      collectedData.push(chunk);
    });
  });

  afterEach(() => {
    mockDestination.destroy();
  });

  test("data written by steps is received by consumers via pipe", async () => {
    // Create a workflow with steps that write to the stream
    const steps: WorkflowStepFunction[] = [
      // Step 1: Write a simple string
      async ({ outputStream, next }) => {
        outputStream.write("Step 1 data");
        next({ status: "success" });
      },
      // Step 2: Write a JSON object
      async ({ outputStream, next }) => {
        outputStream.write({ message: "Step 2 data", value: 42 });
        next({ status: "success" });
      },
      // Step 3: Write buffer data
      async ({ outputStream, next }) => {
        outputStream.write(Buffer.from("Step 3 data"));
        next({ status: "success" });
      },
    ];

    // Create and run the workflow
    const workflow = manager.createWorkflow(steps);
    const { workflow: runningWorkflow, completion } = manager.runWorkflow(
      workflow.id,
    );

    // Pipe the workflow to our mock destination
    runningWorkflow.pipe(mockDestination);

    // Wait for workflow to complete
    await completion;

    // Verify the collected data
    expect(collectedData.length).toBe(3);
    expect(collectedData[0]).toBe("Step 1 data");
    expect(collectedData[1]).toEqual({ message: "Step 2 data", value: 42 });
    expect(Buffer.isBuffer(collectedData[2])).toBe(true);
    expect(collectedData[2].toString()).toBe("Step 3 data");
  });

  test("pipe function returns destination stream for chaining", async () => {
    // Create a workflow with a single step
    const step: WorkflowStepFunction = ({ outputStream, next }) => {
      outputStream.write("Test data");
      next({ status: "success" });
    };

    const workflow = manager.createWorkflow([step]);
    const { workflow: runningWorkflow } = manager.runWorkflow(workflow.id);

    // Test that pipe returns the destination stream for chaining
    const returnedStream = runningWorkflow.pipe(mockDestination);
    expect(returnedStream).toBe(mockDestination);
  });

  test("multiple destinations can pipe from the same workflow", async () => {
    // Create a second destination
    const secondData: any[] = [];
    const secondDestination = new PassThrough({ objectMode: true });
    secondDestination.on("data", (chunk) => {
      secondData.push(chunk);
    });

    // Create a workflow with a step that writes data
    const step: WorkflowStepFunction = ({ outputStream, next }) => {
      outputStream.write("Broadcast message");
      next({ status: "success" });
    };

    const workflow = manager.createWorkflow([step]);
    const { workflow: runningWorkflow, completion } = manager.runWorkflow(
      workflow.id,
    );

    // Pipe to both destinations
    runningWorkflow.pipe(mockDestination);
    runningWorkflow.pipe(secondDestination);

    // Wait for workflow to complete
    await completion;

    // Both destinations should receive the same data
    expect(collectedData.length).toBe(1);
    expect(collectedData[0]).toBe("Broadcast message");
    expect(secondData.length).toBe(1);
    expect(secondData[0]).toBe("Broadcast message");

    // Cleanup
    secondDestination.destroy();
  });

  test("workflow ending properly closes the stream", async () => {
    // Track when the destination stream ends
    let streamEnded = false;
    mockDestination.on("end", () => {
      streamEnded = true;
    });

    // Create a workflow with a simple step
    const step: WorkflowStepFunction = ({ outputStream, next }) => {
      outputStream.write("Final data");
      next({ status: "success" });
    };

    const workflow = manager.createWorkflow([step]);
    const { workflow: runningWorkflow, completion } = manager.runWorkflow(
      workflow.id,
    );

    // Pipe to destination
    runningWorkflow.pipe(mockDestination);

    // Wait for workflow to complete
    await completion;

    // Give stream events time to propagate
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify the stream was properly ended
    expect(streamEnded).toBe(true);
  });

  test("errors in steps are properly propagated", async () => {
    // Create a workflow that will fail
    const errorStep: WorkflowStepFunction = ({ next }) => {
      next({
        status: "failure",
        error: "Intentional test failure",
      });
    };

    // Track when the destination stream errors
    let receivedError: any = null;
    mockDestination.on("error", (err: any) => {
      receivedError = err;
    });

    const workflow = manager.createWorkflow([errorStep]);
    const { workflow: runningWorkflow, completion } = manager.runWorkflow(
      workflow.id,
    );

    // Pipe to destination
    runningWorkflow.pipe(mockDestination);

    // Wait for workflow to complete (should be in error state)
    const completedWorkflow = await completion;

    // Give stream events time to propagate
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify workflow is in failed state
    expect(completedWorkflow.status).toBe("failed");
    expect(completedWorkflow.error).toContain("Intentional test failure");

    // Verify stream received the error
    expect(receivedError).not.toBe(null);
    console.log("Received error:", receivedError);

    // Check if the error has the expected properties
    if (receivedError) {
      // The error might be in different formats depending on the implementation
      // Try different approaches to extract the message
      const errorString = String(receivedError);
      const errorMessage = receivedError.message || errorString;

      expect(errorString + " " + errorMessage).toContain(
        "Intentional test failure",
      );
    }
  });

  // Add a real-world example test case
  test("streaming LLM generation simulation", async () => {
    // Simulate an LLM that generates tokens one by one
    const simulateLLMResponse = async (
      outputStream: Writable,
      text: string,
    ) => {
      const tokens = text.split(" ");
      for (const token of tokens) {
        // Simulate token-by-token generation with delays
        await new Promise((resolve) => setTimeout(resolve, 10));
        outputStream.write(token + " ");
      }
    };

    // Create steps that simulate different parts of a conversation
    const steps: WorkflowStepFunction[] = [
      // Step 1: System message setup
      async ({ outputStream, next }) => {
        await simulateLLMResponse(
          outputStream,
          "I'm an AI assistant. How can I help you today?",
        );
        next({ status: "success" });
      },

      // Step 2: Response to user query
      async ({ outputStream, next }) => {
        await simulateLLMResponse(
          outputStream,
          "Here's the information you requested about workflow streams.",
        );
        next({ status: "success" });
      },

      // Step 3: Conclusion
      async ({ outputStream, next }) => {
        await simulateLLMResponse(
          outputStream,
          "Is there anything else you'd like to know?",
        );
        next({ status: "success" });
      },
    ];

    // Create a workflow with these steps
    const workflow = manager.createWorkflow(steps);
    const { workflow: runningWorkflow, completion } = manager.runWorkflow(
      workflow.id,
    );

    // Track tokens as they arrive
    const receivedTokens: string[] = [];
    const tokenReceiver = new Writable({
      objectMode: true,
      write: (chunk, _, callback) => {
        if (typeof chunk === "string") {
          receivedTokens.push(chunk);
        }
        callback();
      },
    });

    // Connect the workflow to our token receiver
    runningWorkflow.pipe(tokenReceiver);

    // Wait for workflow to complete
    await completion;

    // Check that we received all the tokens
    const expectedTokenCount =
      "I'm an AI assistant. How can I help you today?".split(" ").length +
      "Here's the information you requested about workflow streams.".split(" ")
        .length +
      "Is there anything else you'd like to know?".split(" ").length;

    // Each token gets a space appended
    expect(receivedTokens.length).toBe(expectedTokenCount);

    // Join the tokens and check the content
    const receivedText = receivedTokens.join("").trim();
    expect(receivedText).toContain("I'm an AI assistant");
    expect(receivedText).toContain("information you requested");
    expect(receivedText).toContain("anything else");
  });
});
