/**
 * Test step presets — factory functions returning StepSpec objects (or
 * wrapped specs with observation handles) for the runtime/ API.
 *
 * Each fixture covers one concern: streaming, suspension, timeout, or retry.
 * Tests call Step.make(spec) themselves inside their Effect scope.
 *
 * Streaming uses a stepRef closure so chunks flow through
 * step.channels.chunks rather than a side-channel callback.
 *
 * SuspendSignal is thrown manually from execute. originPath is set to
 * [name] — correct for root-level use; if composed as a child the
 * step.suspended event won't fire (path mismatch) but suspension
 * propagates to the workflow regardless.
 */

import { SuspendSignal } from "../../executable";
import type { Step, StepSpec } from "../../step";
import type { Duration, RetryPolicy } from "../../types";

// ════════════════════════════════════════════════════════════════════════════
// Echo — input passes through unchanged
// ════════════════════════════════════════════════════════════════════════════

export function makeEchoSpec<T>(input: T, name = "echo"): StepSpec<T, T> {
  return {
    execute: async (i) => i,
    input,
    name,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Streaming — emits chunks through step.channels.chunks
// ════════════════════════════════════════════════════════════════════════════

export interface StreamingConfig<S> {
  readonly chunks: readonly S[];
  readonly delayMs?: number;
}

/**
 * Returns a spec and a setter for the Step instance. After calling
 * Step.make(spec), assign the returned Step to setStep() so write()
 * calls flow through step.channels.chunks. Stays generic over `S` by
 * routing every chunk through `write` (non-string values become data
 * chunks; read back as `payload.data`).
 */
export function makeStreamingSpec<S = string>(
  config: StreamingConfig<S>,
  name = "streaming"
): {
  spec: StepSpec<StreamingConfig<S>, "done">;
  setStep: (s: Step<StreamingConfig<S>, "done">) => void;
} {
  let stepRef: Step<StreamingConfig<S>, "done"> | undefined;
  const spec: StepSpec<StreamingConfig<S>, "done"> = {
    execute: async (input): Promise<"done"> => {
      for (const chunk of input.chunks) {
        if (input.delayMs && input.delayMs > 0) {
          await new Promise<void>((r) => setTimeout(r, input.delayMs));
        }
        stepRef?.write(chunk);
      }
      return "done";
    },
    input: config,
    name,
  };
  return {
    setStep: (s) => {
      stepRef = s;
    },
    spec,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Suspending — parks the run by throwing SuspendSignal
// ════════════════════════════════════════════════════════════════════════════

export interface SuspendingConfig {
  readonly meta?: Record<string, unknown>;
  readonly reason: string;
  readonly suspendName: string;
}

export function makeSuspendingSpec(
  config: SuspendingConfig,
  name = "suspending"
): StepSpec<SuspendingConfig> {
  return {
    execute: async (input) => {
      throw new SuspendSignal(
        {
          name: input.suspendName,
          reason: input.reason,
          ...(input.meta ? { meta: input.meta } : {}),
          suspendedAt: new Date().toISOString(),
        },
        [name]
      );
    },
    input: config,
    name,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Timeout — sleeps for workMs; config.timeout triggers the enforced budget
// ════════════════════════════════════════════════════════════════════════════

export interface TimeoutConfig {
  readonly workMs: number;
}

export function makeTimeoutSpec(
  timeout: Duration,
  workMs: number,
  name = "timeout"
): StepSpec<TimeoutConfig, "done"> {
  return {
    config: { timeout },
    execute: async (input): Promise<"done"> => {
      await new Promise<void>((r) => setTimeout(r, input.workMs));
      return "done";
    },
    input: { workMs },
    name,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Counter — counts attempts; succeeds at the Nth try
// ════════════════════════════════════════════════════════════════════════════

export function makeCounterSpec(
  succeedAfter: number,
  retry?: RetryPolicy,
  name = "counter"
): { spec: StepSpec<void, number>; getAttempts: () => number } {
  let attempts = 0;
  const spec: StepSpec<void, number> = {
    input: undefined,
    name,
    ...(retry ? { config: { retry } } : {}),
    execute: async () => {
      attempts += 1;
      if (attempts < succeedAfter) {
        throw new Error(`counter: attempt ${attempts} < ${succeedAfter}`);
      }
      return attempts;
    },
  };
  return { getAttempts: () => attempts, spec };
}
