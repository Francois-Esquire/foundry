import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";

import type {
  LifecycleCallbacks,
  StepExecutionContext,
  TokenUsage,
  Workflow,
  WorkflowStepFunction,
  WorkflowStepResult,
} from "../../src/agents/workflows";

import { WorkflowManager } from "../../src/agents/workflows";

// Adjust path as needed

// Helper function to create a simple step
const createStep = (
  id: number,
  options: {
    delayMs?: number;
    shouldFail?: boolean;
    syncError?: boolean;
    asyncError?: boolean;
    updateContext?: Record<string, any>;
    output?: any;
    usage?: TokenUsage;
    checkContext?: (ctx: Readonly<Record<string, any>>) => void;
    logMessage?: string;
    checkSignal?: boolean; // Add a check for signal aborted status
  } = {},
): WorkflowStepFunction => {
  return async (stepCtx: StepExecutionContext) => {
    const stepName = `Step ${id}`;
    stepCtx.log({ type: "info", message: `${stepName} started.` });
    if (options.logMessage) {
      stepCtx.log({ type: "info", message: options.logMessage });
    }

    // Check context if needed
    if (options.checkContext) {
      try {
        options.checkContext(stepCtx.sharedContext);
      } catch (e: any) {
        stepCtx.next({
          status: "failure",
          error: `${stepName} context check failed: ${e.message}`,
        });
        return;
      }
    }

    // Check signal if requested
    if (options.checkSignal && stepCtx.signal.aborted) {
      stepCtx.log({
        type: "info",
        message: `${stepName} detected abort signal.`,
      });
      stepCtx.next({
        status: "failure",
        error: `${stepName} aborted by signal`,
      });
      return;
    }

    // Simulate potential errors before delay
    if (options.syncError) {
      stepCtx.log({
        type: "info",
        message: `${stepName} throwing sync error.`,
      });
      throw new Error(`${stepName} synchronous error`);
    }
    if (options.asyncError) {
      stepCtx.log({
        type: "info",
        message: `${stepName} returning rejected promise.`,
      });
      await Promise.reject(new Error(`${stepName} asynchronous error`));
      // This line won't be reached, but satisfies type checker if needed
      stepCtx.next({ status: "failure", error: "Should not be reached" });
      return;
    }

    // Simulate async work
    if (options.delayMs && options.delayMs > 0) {
      stepCtx.log({
        type: "info",
        message: `${stepName} starting delay of ${options.delayMs}ms.`,
      });
      await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(resolve, options.delayMs);
        stepCtx.signal.addEventListener("abort", () => {
          clearTimeout(timeoutId);
          stepCtx.log({
            type: "info",
            message: `${stepName} delay aborted by signal.`,
          });
          // Call next with failure when aborted during delay
          stepCtx.next({
            status: "failure",
            error: `${stepName} aborted by signal during delay`,
          });
          // Reject shouldn't be strictly needed as next() handles flow, but good practice
          // reject(new Error(`${stepName} aborted by signal during delay`));
        });
      });
      // If the promise resolved (wasn't aborted during delay), check signal again
      if (stepCtx.signal.aborted) {
        stepCtx.log({
          type: "info",
          message: `${stepName} detected abort signal after delay.`,
        });
        // No need to call next() again if it was called by the abort listener
        return;
      }
      stepCtx.log({ type: "info", message: `${stepName} finished delay.` });
    }

    // Update context if needed
    if (options.updateContext) {
      stepCtx.updateSharedContext(options.updateContext);
      stepCtx.log({ type: "info", message: `${stepName} updated context.` });
    }

    // Decide success or failure
    if (options.shouldFail) {
      stepCtx.log({ type: "info", message: `${stepName} reporting failure.` });
      stepCtx.next({
        status: "failure",
        error: `${stepName} failed as requested`,
        usage: options.usage,
      });
    } else {
      stepCtx.log({ type: "info", message: `${stepName} reporting success.` });
      stepCtx.next({
        status: "success",
        output: options.output ?? { info: `${stepName} success` },
        usage: options.usage,
      });
    }
  };
};

// Helper to delay execution
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("WorkflowManager", () => {
  let manager: WorkflowManager;

  beforeEach(() => {
    manager = new WorkflowManager();
  });

  test("should create a workflow with initial state", () => {
    const step1 = createStep(1);
    const initialContext = { key: "value" };
    const workflow = manager.createWorkflow([step1], initialContext, {
      name: "TestFlow",
    });

    expect(workflow.id).toBeString();
    expect(workflow.name).toBe("TestFlow");
    expect(workflow.status).toBe("pending");
    expect(workflow.steps).toEqual([step1]);
    expect(workflow.context).toEqual(initialContext);
    expect(workflow.context).not.toBe(initialContext); // Ensure context is cloned
    expect(workflow.currentStepIndex).toBe(0);
    expect(workflow.logs.length).toBe(1); // Creation log
    expect(workflow.logs[0]!.type).toBe("info");
    expect(workflow.logs[0]!.message).toContain("created");
    expect(workflow._runState).toBeUndefined();
  });

  test("should retrieve an existing workflow", () => {
    const workflow = manager.createWorkflow([createStep(1)]);
    const retrieved = manager.getWorkflow(workflow.id);
    expect(retrieved).toBe(workflow);
  });

  test("should return undefined for non-existent workflow", () => {
    const retrieved = manager.getWorkflow("non-existent-id");
    expect(retrieved).toBeUndefined();
  });

  test("should run a simple workflow successfully", async () => {
    const step1 = createStep(1, {
      updateContext: { data1: "A" },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const step2 = createStep(2, {
      updateContext: { data2: "B" },
      usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
    });
    const workflow = manager.createWorkflow([step1, step2], {
      initial: "start",
    });

    const { completion } = manager.runWorkflow(workflow.id);
    const finalState = await completion;

    expect(finalState.status).toBe("completed");
    expect(finalState.currentStepIndex).toBe(2); // Index after last step
    expect(finalState.context).toEqual({
      initial: "start",
      data1: "A",
      data2: "B",
    });
    expect(finalState.result).toEqual(finalState.context);
    expect(finalState.error).toBeUndefined();
    expect(
      finalState.logs.some(
        (log) => log.type === "usage" && log.details?.usage.totalTokens === 2,
      ),
    ).toBe(true);
    expect(
      finalState.logs.some(
        (log) => log.type === "usage" && log.details?.usage.totalTokens === 4,
      ),
    ).toBe(true);
    expect(finalState.logs.length).toBeGreaterThan(0);
    expect(finalState.logs[finalState.logs.length - 1]!.message).toContain(
      "completed all steps successfully",
    );
  });

  test("should handle workflow failure on step reporting failure", async () => {
    const step1 = createStep(1, { updateContext: { data1: "A" } });
    const step2 = createStep(2, {
      shouldFail: true,
      updateContext: { data2: "B_fail" },
    });
    const step3 = createStep(3);
    const workflow = manager.createWorkflow([step1, step2, step3], {
      initial: "start",
    });

    // Create a promise that will handle the stream error
    const errorPromise = new Promise<void>((resolve) => {
      const errorHandler = () => {
        // Just log that we caught the expected error
        console.log("Caught expected stream error from step 2 failure");
        resolve();
      };

      process.once("uncaughtException", errorHandler);

      // Clean up error handler after test completes
      setTimeout(() => {
        process.removeListener("uncaughtException", errorHandler);
        resolve();
      }, 300);
    });

    const { completion } = manager.runWorkflow(workflow.id);

    // Wait for both the workflow completion and the error handling
    const [finalState] = await Promise.all([completion, errorPromise]);

    expect(finalState.status).toBe("failed");
    expect(finalState.currentStepIndex).toBe(1); // Failed at step 2 (index 1)
    expect(finalState.context).toEqual({
      initial: "start",
      data1: "A",
      data2: "B_fail",
    }); // Context includes update from failed step
    expect(finalState.result).toBeUndefined();
    expect(finalState.error).toBe("Step 2 failed as requested");
    expect(
      finalState.logs.some((log) => log.message.includes("Step 3 started")),
    ).toBe(false);
    expect(finalState.logs.length).toBeGreaterThan(0);
    expect(finalState.logs[finalState.logs.length - 1]!.message).toContain(
      "Step 2 reported failure",
    );
  });

  test("should handle workflow failure on synchronous step error", async () => {
    const step1 = createStep(1, { updateContext: { data1: "A" } });
    const step2 = createStep(2, { syncError: true });
    const step3 = createStep(3);
    const workflow = manager.createWorkflow([step1, step2, step3]);

    // Create a promise that will handle the stream error
    const errorPromise = new Promise<void>((resolve) => {
      const errorHandler = () => {
        // Just log that we caught the expected error
        console.log("Caught expected stream error from synchronous error");
        resolve();
      };

      process.once("uncaughtException", errorHandler);

      // Clean up error handler after test completes
      setTimeout(() => {
        process.removeListener("uncaughtException", errorHandler);
        resolve();
      }, 300);
    });

    const { completion } = manager.runWorkflow(workflow.id);

    // Wait for both the workflow completion and the error handling
    const [finalState] = await Promise.all([completion, errorPromise]);

    expect(finalState.status).toBe("failed");
    expect(finalState.currentStepIndex).toBe(1); // Error occurred during step 2 (index 1)
    expect(finalState.context).toEqual({ data1: "A" }); // Context before error
    expect(finalState.result).toBeUndefined();
    expect(finalState.error).toBe(
      "Error in async step: Step 2 synchronous error",
    );
    expect(
      finalState.logs.some((log) => log.message.includes("Step 3 started")),
    ).toBe(false);
    expect(
      finalState.logs.some((log) =>
        log.message.includes("Error in async step 2 before next() was called"),
      ),
    ).toBe(true);
  });

  test("should handle workflow failure on asynchronous step error", async () => {
    const step1 = createStep(1, { updateContext: { data1: "A" } });
    const step2 = createStep(2, { asyncError: true });
    const step3 = createStep(3);
    const workflow = manager.createWorkflow([step1, step2, step3]);

    // Create a promise that will handle the stream error
    const errorPromise = new Promise<void>((resolve) => {
      const errorHandler = () => {
        // Just log that we caught the expected error
        console.log("Caught expected stream error from asynchronous error");
        resolve();
      };

      process.once("uncaughtException", errorHandler);

      // Clean up error handler after test completes
      setTimeout(() => {
        process.removeListener("uncaughtException", errorHandler);
        resolve();
      }, 300);
    });

    const { completion } = manager.runWorkflow(workflow.id);

    // Wait for both the workflow completion and the error handling
    const [finalState] = await Promise.all([completion, errorPromise]);

    expect(finalState.status).toBe("failed");
    expect(finalState.currentStepIndex).toBe(1);
    expect(finalState.context).toEqual({ data1: "A" });
    expect(finalState.error).toBe(
      "Error in async step: Step 2 asynchronous error",
    );
    expect(
      finalState.logs.some((log) => log.message.includes("Step 3 started")),
    ).toBe(false);
    expect(
      finalState.logs.some((log) =>
        log.message.includes("Error in async step 2 before next() was called"),
      ),
    ).toBe(true);
  });

  test("should update context correctly between steps", async () => {
    const step1 = createStep(1, { updateContext: { value: 1 } });
    const step2 = createStep(2, {
      checkContext: (ctx) => expect(ctx.value).toBe(1),
      updateContext: { value: 2, added: "yes" },
    });
    const step3 = createStep(3, {
      checkContext: (ctx) => {
        expect(ctx.value).toBe(2);
        expect(ctx.added).toBe("yes");
      },
    });
    const workflow = manager.createWorkflow([step1, step2, step3], {
      initial: 0,
    });
    const { completion } = manager.runWorkflow(workflow.id);
    const finalState = await completion;
    expect(finalState.status).toBe("completed");
    expect(finalState.context).toEqual({ initial: 0, value: 2, added: "yes" });
  });

  test("should prevent context modification via sharedContext", async () => {
    const step1 = async (stepCtx: StepExecutionContext) => {
      stepCtx.log({ type: "info", message: "Step 1 started." });
      try {
        // @ts-expect-error Trying to modify read-only property
        stepCtx.sharedContext.initial = "modified";
        stepCtx.next({ status: "failure", error: "Context was modifiable" });
      } catch (e) {
        // We expect an error here because sharedContext is Readonly
        stepCtx.log({
          type: "info",
          message: "Correctly caught error trying to modify readonly context.",
        });
        stepCtx.updateSharedContext({ testPassed: true });
        stepCtx.next({ status: "success" });
      }
    };
    const workflow = manager.createWorkflow([step1], { initial: "original" });
    const { completion } = manager.runWorkflow(workflow.id);
    const finalState = await completion;
    expect(finalState.status).toBe("completed");
    expect(finalState.context.initial).toBe("original"); // Should not have changed
    expect(finalState.context.testPassed).toBe(true);
  });

  test("should cancel a running workflow", async () => {
    // Create a promise that will handle potential abort signal errors
    const errorPromise = new Promise<void>((resolve) => {
      const errorHandler = () => {
        console.log("Caught expected abort signal error");
        resolve();
      };

      process.once("uncaughtException", errorHandler);

      // Clean up error handler after test completes
      setTimeout(() => {
        process.removeListener("uncaughtException", errorHandler);
        resolve();
      }, 300);
    });

    // Longer-running step
    const step = createStep(1, { delayMs: 500 });
    const workflow = manager.createWorkflow([step]);

    // Start the workflow
    const { completion } = manager.runWorkflow(workflow.id);

    // Cancel after a small delay (before it completes)
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cancelled = await manager.cancelWorkflow(workflow.id);

    expect(cancelled).toBe(true);
    expect(workflow.status).toBe("cancelled");

    // Wait for workflow to finalize and error handling
    const [finalState] = await Promise.all([completion, errorPromise]);
    expect(finalState.status).toBe("cancelled"); // Should not run
  });

  test("should cancel a pending workflow", async () => {
    const step1 = createStep(1);
    const workflow = manager.createWorkflow([step1]);

    expect(workflow.status).toBe("pending");
    const cancelled = await manager.cancelWorkflow(workflow.id);
    expect(cancelled).toBe(true);
    expect(workflow.status).toBe("cancelled");

    // Try to run it
    const { completion } = manager.runWorkflow(workflow.id);
    const finalState = await completion;
    expect(finalState.status).toBe("cancelled"); // Should not run
    expect(
      finalState.logs.some((l) => l.message.includes("Workflow run initiated")),
    ).toBe(false);
  });

  test("should not cancel a completed workflow", async () => {
    const workflow = manager.createWorkflow([createStep(1)]);
    const { completion } = manager.runWorkflow(workflow.id);
    await completion;
    expect(workflow.status).toBe("completed");

    const cancelled = await manager.cancelWorkflow(workflow.id);
    expect(cancelled).toBe(false);
    expect(workflow.status).toBe("completed");
  });

  test("should not cancel a failed workflow", async () => {
    const workflow = manager.createWorkflow([
      createStep(1, { shouldFail: true }),
    ]);

    // Create a promise that will handle the stream error
    const errorPromise = new Promise<void>((resolve) => {
      const errorHandler = () => {
        // Just log that we caught the expected error
        console.log("Caught expected stream error from failed workflow");
        resolve();
      };

      process.once("uncaughtException", errorHandler);

      // Clean up error handler after test completes
      setTimeout(() => {
        process.removeListener("uncaughtException", errorHandler);
        resolve();
      }, 300);
    });

    const { completion } = manager.runWorkflow(workflow.id);
    await Promise.all([completion, errorPromise]);

    expect(workflow.status).toBe("failed");

    const cancelled = await manager.cancelWorkflow(workflow.id);
    expect(cancelled).toBe(false);
    expect(workflow.status).toBe("failed");
  });

  test("should prevent concurrent runs and return existing workflow", async () => {
    const step1 = createStep(1, { delayMs: 100 });
    const workflow = manager.createWorkflow([step1]);

    const result1 = manager.runWorkflow(workflow.id);
    // Try running again immediately
    const result2 = manager.runWorkflow(workflow.id);

    expect(result1).not.toBe(result2);
    expect(result1.workflow).toBe(result2.workflow);

    // Ensure both completions point to the same promise
    expect(result1.completion).toBe(result2.completion);

    // Wait for completion
    await result1.completion;
  });

  test("should not run a workflow in a terminal state", async () => {
    const step1 = createStep(1);
    const workflow = manager.createWorkflow([step1]);

    // Run to completion
    const { completion } = manager.runWorkflow(workflow.id);
    await completion;
    expect(workflow.status).toBe("completed");

    // Try to run again
    const result = manager.runWorkflow(workflow.id);
    expect(result.workflow.status).toBe("completed"); // Should not have changed

    // Completion promise should resolve immediately with the existing workflow
    const finalState = await result.completion;
    expect(finalState.status).toBe("completed");
  });

  test("should run workflow with zero steps successfully", async () => {
    const workflow = manager.createWorkflow([], { initial: "empty" });
    const { completion } = manager.runWorkflow(workflow.id);
    const finalState = await completion;
    expect(finalState.status).toBe("completed");
    expect(finalState.context).toEqual({ initial: "empty" });
    expect(finalState.result).toEqual({ initial: "empty" });
    expect(finalState.currentStepIndex).toBe(0);
    expect(finalState.logs.length).toBeGreaterThan(0);
    expect(finalState.logs[finalState.logs.length - 1]!.message).toContain(
      "completed all steps successfully",
    );
  });

  // --- Tests for Lifecycle Callbacks ---

  test("should invoke lifecycle callbacks correctly on success", async () => {
    const tickCalls: any[] = [];
    const nextCalls: any[] = [];
    let successCalled = false;
    let errorCalled = false;
    let cancelCalled = false;

    const callbacks = {
      onTick: (context: any, workflow: any) => {
        tickCalls.push({ ...context });
      },
      onNext: (workflow: any, result: any) => {
        nextCalls.push({ ...result });
      },
      onSuccess: (workflow: any) => {
        successCalled = true;
      },
      onError: (workflow: any) => {
        errorCalled = true;
      },
      onCancel: (workflow: any) => {
        cancelCalled = true;
      },
    };

    const step1 = createStep(1);
    const step2 = createStep(2);
    const workflow = manager.createWorkflow(
      [step1, step2],
      { initial: "start" },
      { name: "CallbackFlow" },
    );

    const { completion } = manager.runWorkflow(workflow.id, { callbacks });
    const finalState = await completion;

    expect(finalState.status).toBe("completed");
    expect(tickCalls.length).toBeGreaterThan(0);
    expect(nextCalls.length).toBe(2); // One for each step
    expect(successCalled).toBe(true);
    expect(errorCalled).toBe(false);
    expect(cancelCalled).toBe(false);
  });

  test("should invoke lifecycle callbacks correctly on failure", async () => {
    const tickCalls: any[] = [];
    const nextCalls: any[] = [];
    let successCalled = false;
    let errorCalled = false;
    let cancelCalled = false;

    const callbacks = {
      onTick: (context: any, workflow: any) => {
        tickCalls.push({ ...context });
      },
      onNext: (workflow: any, result: any) => {
        nextCalls.push({ ...result });
      },
      onSuccess: (workflow: any) => {
        successCalled = true;
      },
      onError: (workflow: any) => {
        errorCalled = true;
      },
      onCancel: (workflow: any) => {
        cancelCalled = true;
      },
    };

    // Create a promise that will handle the stream error
    const errorPromise = new Promise<void>((resolve) => {
      const errorHandler = () => {
        // Just log that we caught the expected error
        console.log("Caught expected stream error from callback failure test");
        resolve();
      };

      process.once("uncaughtException", errorHandler);

      // Clean up error handler after test completes
      setTimeout(() => {
        process.removeListener("uncaughtException", errorHandler);
        resolve();
      }, 300);
    });

    const step1 = createStep(1);
    const step2 = createStep(2, { shouldFail: true });
    const workflow = manager.createWorkflow([step1, step2]);

    const { completion } = manager.runWorkflow(workflow.id, { callbacks });

    // Wait for both the workflow completion and the error handling
    const [finalState] = await Promise.all([completion, errorPromise]);

    expect(finalState.status).toBe("failed");
    expect(tickCalls.length).toBeGreaterThan(0);
    expect(nextCalls.length).toBe(1); // Only step 1 succeeds
    expect(successCalled).toBe(false);
    expect(errorCalled).toBe(true);
    expect(cancelCalled).toBe(false);
  });

  test("should invoke lifecycle callbacks correctly on cancellation", async () => {
    // Create a promise that will handle potential abort signal errors
    const errorPromise = new Promise<void>((resolve) => {
      const errorHandler = () => {
        console.log("Caught expected abort signal error in callback test");
        resolve();
      };

      process.once("uncaughtException", errorHandler);

      // Clean up error handler after test completes
      setTimeout(() => {
        process.removeListener("uncaughtException", errorHandler);
        resolve();
      }, 300);
    });

    const callbacks: LifecycleCallbacks = {
      onTick: jest.fn(),
      onNext: jest.fn(),
      onSuccess: jest.fn(),
      onError: jest.fn(),
      onCancel: jest.fn(),
    };
    // Use step that checks signal during delay
    const step1 = createStep(1, { delayMs: 500, checkSignal: true });
    const step2 = createStep(2);
    const workflow = manager.createWorkflow([step1, step2]);

    const { completion } = manager.runWorkflow(workflow.id, { callbacks });

    // Wait briefly then cancel
    await delay(100);
    await manager.cancelWorkflow(workflow.id);

    // Wait for both completion and error handling
    const [finalState] = await Promise.all([completion, errorPromise]);

    expect(finalState.status).toBe("cancelled");

    // onCancel: Called exactly once
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
    expect(callbacks.onCancel).toHaveBeenCalledWith(workflow);

    // onSuccess / onError: Should not be called for cancellation path
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });
});

// --- Example Usage (Illustrative) ---
/*
async function exampleWithDuplexStream() {
  const manager = new WorkflowManager();

  // Step that streams data using outputStream.push()
  const streamingStep: WorkflowStepFunction = async (stepCtx) => {
    stepCtx.log({ type: 'info', message: 'Streaming step started.' });
    let count = 0;
    const intervalId = setInterval(() => {
      if (stepCtx.signal.aborted) {
        clearInterval(intervalId);
        stepCtx.log({ type: 'info', message: 'Streaming step interval aborted.'});
        // Don't call next if aborted, let termination logic handle it.
        // Stream will be destroyed by the manager.
        return;
      }
      if (count >= 5) {
        clearInterval(intervalId);
        stepCtx.log({ type: 'info', message: 'Streaming step finished streaming.' });
        stepCtx.next({ status: 'success', output: { finalCount: count } });
      } else {
        // NOTE: Pushing strings or Buffers is standard for streams
        const chunk = `Chunk ${count} `;
        stepCtx.log({ type: 'info', message: `Pushing chunk ${count}` });
        // Push data to the stream
        stepCtx.outputStream.push(chunk);
        count++;
      }
    }, 100);
  };

  const finalStep: WorkflowStepFunction = (stepCtx) => {
     stepCtx.log({ type: 'info', message: 'Final step processing.'});
     stepCtx.outputStream.push('Final processing complete. '); // Push final data
     stepCtx.next({ status: 'success', output: { finalMessage: 'All done!' }});
  }

  const workflow = manager.createWorkflow([streamingStep, finalStep]);

  console.log(`Running workflow ${workflow.id} with Duplex stream...`);
  try {
      const { stream, completion } = manager.runWorkflow(workflow.id, {
           callbacks: { // Optional callbacks
              onTick: (_, wf) => { console.log(`Tick - Step ${wf.currentStepIndex+1}`); },
              onSuccess: (wf) => { console.log(`\nWorkflow Success Callback! Final context:`, wf.context); }
           }
      });

      console.log('Got stream, starting consumption...');
      let receivedData = '';
      stream.on('data', (chunk: any) => {
          // Assuming chunks are strings/buffers that can be converted
          const data = chunk.toString();
          receivedData += data;
          process.stdout.write(`[STREAM DATA] ${data}\n`); // Log stream chunks
      });
      stream.on('end', () => {
          console.log('[STREAM END] Stream finished.');
          console.log('Total data received:', receivedData);
      });
      stream.on('error', (err: Error) => {
          console.error('[STREAM ERROR]', err.message);
      });
      stream.on('close', () => {
           console.log('[STREAM CLOSE] Stream closed.');
      });


      console.log('Waiting for workflow completion promise...');
      const finalState = await completion; // Wait for the workflow logic itself to finish
      console.log(`---> Workflow Completion Promise Resolved <---`);
      console.log(`Final Workflow State: ID=${finalState.id}, Status=${finalState.status}, Error=${finalState.error}`);

  } catch(e: any) {
      console.error("RunWorkflow threw error:", e.message);
  }
}

// exampleWithDuplexStream();
*/

// Note: Need to install uuid: `bun add uuid @types/uuid`
