import { Duplex, pipeline, Readable, Transform, Writable } from "node:stream";
import type {
  GenerateObjectResult,
  GenerateTextResult,
  Output,
  ToolSet,
} from "ai";
import type { TransformOptions } from "node:stream";

import { v4 as uuidv4 } from "uuid";

// --- Core Types ---

export type WorkflowStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowLogEntry = {
  timestamp: number; // Unix timestamp (ms)
  type: "info" | "error" | "usage" | "tool_call" | "sub_workflow";
  message: string;
  details?: Record<string, any>; // For errors, tool params, usage data etc.
};

// Define a type for token usage explicitly, mirroring Vercel AI SDK's structure
// if CoreUsage isn't directly available or suitable.
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Context shared between workflow steps
export type WorkflowContext = Record<string, any>;

// Result passed to the next() function
export type WorkflowStepResult<
  T extends ToolSet = ToolSet,
  TT = Output.Output<any, any>,
> = {
  status: "success" | "failure";
  output?: GenerateObjectResult<T> | GenerateTextResult<T, TT> | null; // Optional data produced by the step (can be merged by manager if needed)
  error?: unknown | null; // Error message if status is failure
  usage?: TokenUsage; // Token usage from AI calls
};

// --- Lifecycle Callback Types ---
export type OnTickCallback = (
  context: Readonly<WorkflowContext>,
  workflow: Readonly<Workflow>,
) => void;
export type OnNextCallback = (
  workflow: Readonly<Workflow>,
  stepResult: Readonly<WorkflowStepResult>,
) => void;
export type OnSuccessCallback = (workflow: Readonly<Workflow>) => void;
export type OnErrorCallback = (workflow: Readonly<Workflow>) => void;
export type OnCancelCallback = (workflow: Readonly<Workflow>) => void;

export interface LifecycleCallbacks {
  onTick?: OnTickCallback;
  onNext?: OnNextCallback;
  onSuccess?: OnSuccessCallback;
  onError?: OnErrorCallback;
  onCancel?: OnCancelCallback;
}

// Options for running a workflow, including callbacks
export interface RunWorkflowOptions {
  callbacks?: LifecycleCallbacks;
}

// Represents the execution environment and capabilities provided to a single step
export interface StepExecutionContext {
  // Read-only view of the shared context from previous steps
  readonly sharedContext: Readonly<WorkflowContext>;

  // Update the shared context for subsequent steps
  updateSharedContext(updates: Partial<WorkflowContext>): void;

  // Log entries specific to this workflow run
  log(entry: Omit<WorkflowLogEntry, "timestamp">): void;

  // Function to call when the step is complete (success or failure)
  next(result: WorkflowStepResult): void;

  // Add other potential capabilities here in the future, e.g.:
  // getWorkflowId(): string;
  // getStepIndex(): number;
  readonly signal: AbortSignal;
  /** The output stream for this workflow run. Steps push data here. */
  readonly outputStream: Writable;
}

// Function signature for a workflow step using the next() pattern
export type WorkflowStepFunction = (
  stepContext: StepExecutionContext, // Pass the enhanced context object
) => Promise<void> | void; // Steps now call next(), return type less critical

export interface Workflow {
  id: string;
  name?: string; // Optional name for the workflow
  status: WorkflowStatus;
  steps: WorkflowStepFunction[];
  currentStepIndex: number; // Tracks the step *about* to be executed
  context: WorkflowContext;
  logs: WorkflowLogEntry[];
  createdAt: number;
  updatedAt: number;
  result?: any; // Final result of the workflow
  error?: unknown | null; // Final error if failed

  // Stream method for consumers
  pipe<T extends NodeJS.WritableStream>(destination: T): T;

  // Internal state for a specific run
  _runState?: {
    completionPromise: {
      promise: Promise<Workflow>;
      resolve: (value: Workflow | PromiseLike<Workflow>) => void;
      reject: (reason?: any) => void;
    };
    abortController: AbortController;
    callbacks?: LifecycleCallbacks; // Store callbacks for the run
    internalStream: Transform; // Internal stream for steps to write to
  };
}

// Result returned by runWorkflow
export interface RunWorkflowResult {
  workflow: Workflow; // Return the workflow so consumers can pipe from it
  completion: Promise<Workflow>; // Promise for final state
}

// --- Workflow Stream Implementation ---
// Internal transform stream that steps write to
class WorkflowInternalStream extends Transform {
  constructor(options?: TransformOptions) {
    super({
      ...options,
      objectMode: true, // Handle any kind of data
    });

    // Add error handling to prevent uncaught exceptions
    this.on("error", (err) => {
      // Just log the error but don't rethrow - it's expected in some cases
      console.log(
        `[WorkflowStream] Error (handled internally): ${err.message}`,
      );
    });
  }

  _transform(
    chunk: any,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: any) => void,
  ): void {
    // Simply pass chunks through
    this.push(chunk);
    callback();
  }

  _flush(callback: (error?: Error | null) => void): void {
    callback();
  }
}

// --- Workflow Manager ---

export class WorkflowManager {
  private workflows: Map<string, Workflow> = new Map();

  // Helper to safely invoke lifecycle callbacks (remains the same)
  private _invokeCallback<T extends keyof LifecycleCallbacks>(
    workflow: Workflow,
    callbackName: T,
    ...args: Parameters<NonNullable<LifecycleCallbacks[T]>>
  ): void {
    const callback = workflow._runState?.callbacks?.[callbackName];
    if (typeof callback === "function") {
      try {
        // Use Function.prototype.apply to pass arguments as an array
        (callback as (...args: any[]) => void).apply(null, args);
      } catch (error) {
        console.error(
          `Error executing workflow callback '${callbackName}' for workflow ${workflow.id}:`,
          error,
        );
        // Log this as a system error within the workflow itself?
        this.log(workflow.id, {
          type: "error",
          message: `Error executing lifecycle callback: ${callbackName}`,
          details: { error: String(error), stack: (error as Error)?.stack },
        });
      }
    }
  }

  // Utility function to convert WorkflowStatus to a terminal status
  private toTerminalStatus(
    status: WorkflowStatus,
  ): "cancelled" | "failed" | "completed" {
    if (
      status === "cancelled" ||
      status === "failed" ||
      status === "completed"
    ) {
      return status;
    }
    // Default non-terminal statuses to 'failed'
    return "failed";
  }

  private log(
    workflowId: string,
    entry: Omit<WorkflowLogEntry, "timestamp">,
  ): void {
    const workflow = this.workflows.get(workflowId);
    if (workflow) {
      const logEntry: WorkflowLogEntry = {
        ...entry,
        timestamp: Date.now(),
      };
      workflow.logs.push(logEntry);
      workflow.updatedAt = logEntry.timestamp;
    } else {
      console.error(
        `Attempted to log for non-existent workflow: ${workflowId}`,
      );
    }
  }

  // Internal method to handle step completion and trigger the next step
  private _handleStepCompletion(
    workflowId: string,
    completedStepIndex: number,
    result: WorkflowStepResult,
  ): void {
    const workflow = this.workflows.get(workflowId);
    // Ensure workflow and run state exist
    if (!workflow || !workflow._runState) {
      console.error(
        `Cannot handle completion for inactive/unknown workflow run: ${workflowId}`,
      );
      return;
    }

    workflow.updatedAt = Date.now();

    if (result.usage) {
      this.log(workflowId, {
        type: "usage",
        message: `Token usage for step ${completedStepIndex + 1}.`,
        details: { usage: result.usage },
      });
      // Tick after usage log
      this._invokeCallback(workflow, "onTick", workflow.context, workflow);
    }

    if (result.status === "success") {
      this.log(workflowId, {
        type: "info",
        message: `Step ${completedStepIndex + 1} reported success.`,
      });
      // Tick after step success log
      this._invokeCallback(workflow, "onTick", workflow.context, workflow);
      // Invoke onNext callback *before* proceeding
      this._invokeCallback(workflow, "onNext", workflow, result);

      // Proceed to the next step
      const nextStepIndex = completedStepIndex + 1;
      // IMPORTANT: We need to set the workflow's internal index marker *before* calling _executeStep for the next one.
      workflow.currentStepIndex = nextStepIndex;
      this._executeStep(workflowId, nextStepIndex);
    } else {
      // Step reported failure
      workflow.status = "failed";
      workflow.error =
        result.error || "Step failed without specific error message.";
      this.log(workflowId, {
        type: "error",
        message: `Step ${completedStepIndex + 1} reported failure: ${
          workflow.error
        }`,
        details: { error: result.error },
      });
      // Invoke onError callback
      this._invokeCallback(workflow, "onError", workflow);
      // End the internal stream with error - create error with full message
      if (!workflow._runState.internalStream.destroyed) {
        const errorWithFullMessage = new Error(workflow.error as string);
        // Add custom property to help with identification/debugging
        Object.defineProperty(errorWithFullMessage, "workflowError", {
          value: true,
          enumerable: true,
        });
        workflow._runState.internalStream.destroy(errorWithFullMessage);
      }
      // Resolve the main promise with the failed state
      workflow._runState.completionPromise.resolve(workflow);
    }
  }

  // Internal method to execute a single step
  private _executeStep(workflowId: string, stepIndex: number): void {
    const workflow = this.workflows.get(workflowId);

    if (!workflow || !workflow._runState) {
      // Check _runState existence
      console.error(
        `Cannot execute step for inactive/unknown/unprepared workflow run: ${workflowId}`,
      );
      workflow?._runState?.completionPromise?.reject(
        // Reject if possible
        new Error(`Workflow run state inconsistent during execution.`),
      );
      return;
    }
    const { completionPromise, abortController, callbacks, internalStream } =
      workflow._runState;
    const signal = abortController.signal;

    // Helper to terminate run and resolve promise
    const terminateRun = (
      finalStatus: "cancelled" | "failed" | "completed",
      error?: Error,
    ) => {
      if (workflow.status === "running") {
        // Only update status and invoke callbacks if we're transitioning from running
        workflow.status = finalStatus; // Update status

        // Invoke appropriate callback based on intended final status
        // but only when we're changing state from running
        if (finalStatus === "cancelled")
          this._invokeCallback(workflow, "onCancel", workflow);
        else if (finalStatus === "failed")
          this._invokeCallback(workflow, "onError", workflow);
        else if (finalStatus === "completed")
          this._invokeCallback(workflow, "onSuccess", workflow);
      }

      // Always handle the stream and resolve promise, regardless of previous state
      if (!internalStream.destroyed) {
        try {
          if (error) {
            // Add error event handlers to catch any errors during destruction
            internalStream.destroy(error);
          } else {
            internalStream.end(); // Signal clean end
          }
        } catch (err) {
          // Log but swallow any errors during stream destruction
          console.log(
            `[WorkflowManager] Error during stream termination: ${err}`,
          );
        }
      }

      completionPromise.resolve(workflow);
    };

    // Check overall workflow status before proceeding
    if (workflow.status !== "running") {
      this.log(workflowId, {
        type: "info",
        message: `Workflow execution halt. Status: ${workflow.status}.`,
      });
      if (workflow.status === "cancelled" && !signal.aborted)
        abortController.abort();

      // Handle each terminal state explicitly to satisfy TypeScript
      if (workflow.status === "cancelled") {
        terminateRun("cancelled", new Error("Workflow cancelled"));
      } else if (workflow.status === "failed") {
        terminateRun(
          "failed",
          new Error((workflow.error as Error)?.message || "Workflow failed"),
        );
      } else if (workflow.status === "completed") {
        terminateRun("completed");
      } else {
        // For 'pending' - should not normally happen, but handle it
        workflow.status = "failed";
        const error = new Error("Invalid workflow state transition");
        workflow.error = error.message;
        terminateRun("failed", error);
      }
      return;
    }

    if (signal.aborted) {
      this.log(workflowId, {
        type: "info",
        message: `Workflow run aborted before executing step ${stepIndex + 1}.`,
      });
      workflow.status = "cancelled"; // Ensure status reflects cancellation
      this._invokeCallback(workflow, "onCancel", workflow); // Invoke cancel callback *here*
      terminateRun("cancelled", new Error("Workflow aborted"));
      return;
    }

    // Check if we've completed all steps
    if (stepIndex >= workflow.steps.length) {
      workflow.status = "completed";
      workflow.result = workflow.context;
      workflow.updatedAt = Date.now();
      this.log(workflowId, {
        type: "info",
        message: "Workflow completed all steps successfully.",
      });
      this._invokeCallback(workflow, "onSuccess", workflow); // Invoke success callback
      terminateRun("completed");
      return;
    }

    workflow.currentStepIndex = stepIndex;
    const stepFunction = workflow.steps[stepIndex];

    if (!stepFunction) {
      workflow.status = "failed";
      workflow.error = `Internal error: Step function at index ${stepIndex} is undefined.`;
      workflow.updatedAt = Date.now();
      this.log(workflowId, {
        type: "error",
        message: (workflow.error as Error)?.message || "Workflow failed",
      });
      this._invokeCallback(workflow, "onError", workflow); // Invoke error callback
      terminateRun(
        "failed",
        new Error((workflow.error as Error)?.message || "Workflow failed"),
      );
      return;
    }

    this.log(workflowId, {
      type: "info",
      message: `Executing step ${stepIndex + 1}/${workflow.steps.length}...`,
    });
    // Tick when starting a step
    this._invokeCallback(workflow, "onTick", workflow.context, workflow);

    // Create the execution context for the step
    const stepContext: StepExecutionContext = {
      sharedContext: Object.freeze({ ...workflow.context }),
      updateSharedContext: (updates: Partial<WorkflowContext>) => {
        if (workflow.status === "running") {
          Object.assign(workflow.context, updates);
          workflow.updatedAt = Date.now();
          // Tick after context update
          this._invokeCallback(workflow, "onTick", workflow.context, workflow);
        } else {
          this.log(workflowId, {
            type: "info",
            message: `Ignoring context update in non-running state (${workflow.status})`,
          });
        }
      },
      log: (entry: Omit<WorkflowLogEntry, "timestamp">) => {
        this.log(workflowId, entry);
      },
      next: (result: WorkflowStepResult) => {
        // Check signal and status before processing next()
        if (!signal.aborted && workflow.status === "running") {
          setTimeout(
            () => this._handleStepCompletion(workflowId, stepIndex, result),
            0,
          );
        } else {
          const reason = signal.aborted
            ? "abort signal"
            : `non-running state (${workflow.status})`;
          this.log(workflowId, {
            type: "info",
            message: `Ignoring next() call due to ${reason} for step ${
              stepIndex + 1
            }`,
          });
          // Only terminate here if it wasn't already handled by the main checks
          if (!internalStream.destroyed) {
            terminateRun(
              // Use utility function to convert any status to a valid terminal status
              this.toTerminalStatus(workflow.status),
              new Error(`Workflow ended due to ${reason}`),
            );
          }
        }
      },
      signal: signal,
      outputStream: internalStream,
    };

    // Execute the step function
    try {
      if (signal.aborted) {
        // Re-check signal just before execution
        this.log(workflowId, {
          type: "info",
          message: `Workflow run aborted just before calling step ${
            stepIndex + 1
          }.`,
        });
        workflow.status = "cancelled";
        this._invokeCallback(workflow, "onCancel", workflow);
        terminateRun("cancelled", new Error("Workflow aborted"));
        return;
      }

      // Directly call the step function. If it throws synchronously, the catch block below will handle it.
      const promiseOrVoid = stepFunction(stepContext);

      // If it returned a promise, attach a catch handler for async errors *before* next() is called.
      if (promiseOrVoid instanceof Promise) {
        promiseOrVoid.catch((error: any) => {
          if (!signal.aborted) {
            // Process error only if not aborted
            this.log(workflowId, {
              type: "error",
              // Generic message for errors caught via promise rejection
              message: `Error in async step ${
                stepIndex + 1
              } before next() was called: ${error?.message || String(error)}`,
              details: { error: String(error), stack: error?.stack },
            });
            // Use the step's next() mechanism to report failure correctly
            stepContext.next({
              status: "failure",
              // Pass the specific error message
              error: `Error in async step: ${error?.message || String(error)}`,
            });
          } else {
            this.log(workflowId, {
              type: "info",
              message: `Caught async error in step ${
                stepIndex + 1
              } but workflow was already aborted.`,
            });
            // Ensure workflow terminates correctly
            if (workflow.status === "running" && workflow._runState) {
              workflow.status = "cancelled";
              // No duplicate onCancel call here, let the main checks handle it
              terminateRun("cancelled", new Error("Workflow aborted"));
            }
          }
        });
      }
      // IMPORTANT: If the function is synchronous and doesn't throw, it MUST call stepContext.next().
      // If it's async and doesn't throw before next(), it MUST eventually call stepContext.next().
    } catch (error: any) {
      if (!signal.aborted) {
        // Process error only if not aborted
        // This block catches synchronous errors thrown *directly* by stepFunction call.
        this.log(workflowId, {
          type: "error",
          message: `Synchronous error during step ${stepIndex + 1} execution: ${
            error?.message || String(error)
          }`,
          details: { error: String(error), stack: error?.stack },
        });
        // Use the step's next() mechanism to report failure correctly
        stepContext.next({
          status: "failure",
          error: `Synchronous error in step: ${
            error?.message || String(error)
          }`,
        });
      } else {
        this.log(workflowId, {
          type: "info",
          message: `Caught sync error in step ${
            stepIndex + 1
          } but workflow was already aborted.`,
        });
        // Ensure workflow terminates correctly
        if (workflow.status === "running" && workflow._runState) {
          workflow.status = "cancelled";
          terminateRun("cancelled", new Error("Workflow aborted"));
        }
      }
    }
  }

  createWorkflow(
    steps: WorkflowStepFunction[],
    initialContext: WorkflowContext = {},
    options?: { name?: string }, // Optional: Add workflow name on creation
  ): Workflow {
    const workflowId = uuidv4();
    const now = Date.now();

    // Create an internal stream for the workflow
    const internalStream = new WorkflowInternalStream();

    // Create the pipe function for the workflow
    const pipe = <T extends NodeJS.WritableStream>(destination: T): T => {
      // If the workflow is not running, it's a no-op
      if (
        !this.workflows.has(workflowId) ||
        !this.workflows.get(workflowId)?._runState
      ) {
        console.warn(
          `Cannot pipe from workflow ${workflowId}: not running or no run state`,
        );
        return destination;
      }

      const workflow = this.workflows.get(workflowId)!;

      // Setup the pipeline from the internal stream to the destination
      pipeline(workflow._runState!.internalStream, destination, (err) => {
        if (err) {
          console.error(`Pipeline error in workflow ${workflowId}:`, err);
        }
      });

      return destination;
    };

    const newWorkflow: Workflow = {
      id: workflowId,
      name: options?.name,
      status: "pending",
      steps,
      currentStepIndex: 0,
      context: { ...initialContext },
      logs: [],
      createdAt: now,
      updatedAt: now,
      pipe, // Attach the pipe function to the workflow
      _runState: undefined, // No run state initially
    };
    this.workflows.set(workflowId, newWorkflow);
    this.log(workflowId, {
      type: "info",
      message: `Workflow '${options?.name || workflowId}' created.`,
    });

    return newWorkflow;
  }

  getWorkflow(workflowId: string): Workflow | undefined {
    return this.workflows.get(workflowId);
  }

  // Updated runWorkflow signature returns RunWorkflowResult
  runWorkflow(
    workflowId: string,
    options?: RunWorkflowOptions,
  ): RunWorkflowResult {
    const workflow = this.workflows.get(workflowId);

    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    // Check if already actively running
    if (workflow._runState && workflow.status === "running") {
      this.log(workflowId, {
        type: "info",
        message: `Workflow run already in progress. Returning existing workflow.`,
      });
      return {
        workflow, // Return the workflow object directly for piping
        completion: workflow._runState.completionPromise.promise,
      };
    }

    // Prevent starting a new run if already in a terminal state
    if (
      workflow.status === "completed" ||
      workflow.status === "failed" ||
      workflow.status === "cancelled"
    ) {
      this.log(workflowId, {
        type: "info",
        message: `Workflow already in terminal status: ${workflow.status}. Cannot run again without reset.`,
      });
      // Return the workflow in its current state
      return {
        workflow,
        completion: Promise.resolve(workflow),
      };
    }

    // --- Start a new run ---
    let resolvePromise!: (value: Workflow | PromiseLike<Workflow>) => void;
    let rejectPromise!: (reason?: any) => void;
    const promise = new Promise<Workflow>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const abortController = new AbortController();

    // Create a fresh internal stream for this run
    const internalStream = new WorkflowInternalStream();

    // Reset state
    workflow.status = "running";
    workflow.currentStepIndex = 0;
    workflow.error = undefined;
    workflow.result = undefined;
    workflow.updatedAt = Date.now();

    // Assign run state
    workflow._runState = {
      completionPromise: {
        promise,
        resolve: resolvePromise,
        reject: rejectPromise,
      },
      abortController: abortController,
      callbacks: options?.callbacks,
      internalStream, // Store the internal stream
    };

    this.log(workflowId, { type: "info", message: "Workflow run initiated." });

    // Start the first step
    this._executeStep(workflowId, 0);

    // Return the workflow object and completion promise
    return {
      workflow, // Return the workflow object with pipe method
      completion: workflow._runState.completionPromise.promise,
    };
  }

  async cancelWorkflow(workflowId: string): Promise<boolean> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      return false;
    }

    if (workflow.status === "running" || workflow.status === "pending") {
      const oldStatus = workflow.status;
      workflow.status = "cancelled";
      workflow.updatedAt = Date.now();
      this.log(workflowId, {
        type: "info",
        message: `Workflow cancellation requested (was ${oldStatus}).`,
      });

      this._invokeCallback(workflow, "onCancel", workflow); // Can invoke lifecycle callback

      if (oldStatus === "running" && workflow._runState) {
        this.log(workflowId, {
          type: "info",
          message: "Aborting controller and destroying stream.",
        });
        // Abort signal first to stop processing
        workflow._runState.abortController.abort();

        // Destroy stream with error - this will affect both the writable side and readable side
        if (!workflow._runState.internalStream.destroyed) {
          try {
            workflow._runState.internalStream.destroy(
              new Error("Workflow cancelled"),
            );
          } catch (err) {
            // Swallow any errors during destruction - they're expected in test scenarios
            console.log(
              `[WorkflowManager] Error during stream destruction in cancel: ${err}`,
            );
          }
        }
        // Let _executeStep handle promise resolution
      }
      return true;
    } else {
      this.log(workflowId, {
        type: "info",
        message: `Cannot cancel workflow already in status: ${workflow.status}.`,
      });
      return false;
    }
  }
}
