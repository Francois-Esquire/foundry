/**
 * Test step presets — factory functions returning StepSpec objects (or
 * wrapped specs with observation handles) for the runtime/ API.
 *
 * Each fixture covers one concern: streaming, suspension, timeout,
 * nesting, fanout, metadata, retry, emit, bail, slow, depth-inspection.
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
import { bail } from "../../types";

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
// Nested — linear depth tree; each level drives children[0]
// ════════════════════════════════════════════════════════════════════════════

export interface DepthConfig {
  readonly current: number;
  readonly target: number;
}

export interface DepthOutput {
  readonly reachedDepth: number;
}

export function makeNestedSpec(
  target: number,
  name = "nested"
): StepSpec<DepthConfig, DepthOutput> {
  function level(current: number): StepSpec<DepthConfig, DepthOutput> {
    return {
      children: (current < target
        ? [level(current + 1)]
        : []) as readonly StepSpec[],
      execute: async (input, ctx) => {
        const [first] = ctx.children;
        if (input.current >= input.target || !first) {
          return { reachedDepth: input.current };
        }
        return first.run({
          current: input.current + 1,
          target: input.target,
        }) as Promise<DepthOutput>;
      },
      input: { current, target },
      name: current === 0 ? name : `${name}-level-${current}`,
    };
  }
  return level(0);
}

// ════════════════════════════════════════════════════════════════════════════
// Fanout — N-ary tree; each level drives all children in parallel
// ════════════════════════════════════════════════════════════════════════════

export interface FanoutConfig {
  readonly current: number;
  readonly fanout: number;
  readonly target: number;
}

export function makeFanoutSpec(
  target: number,
  fanout: number,
  name = "fanout"
): StepSpec<FanoutConfig, { depth: number; width: number }> {
  function level(
    current: number,
    id: string
  ): StepSpec<FanoutConfig, { depth: number; width: number }> {
    const children =
      current < target
        ? Array.from({ length: fanout }, (_, i) =>
            level(current + 1, `${id}-child-${i}`)
          )
        : [];
    return {
      children: children as readonly StepSpec[],
      execute: async (input, ctx) => {
        if (input.current >= input.target || ctx.children.length === 0) {
          return { depth: input.current, width: 0 };
        }
        await Promise.all(
          ctx.children.map((k) =>
            k.run({
              current: input.current + 1,
              fanout: input.fanout,
              target: input.target,
            })
          )
        );
        return { depth: input.current, width: input.fanout };
      },
      input: { current, fanout, target },
      name: id,
    };
  }
  return level(0, name);
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
      attempts++;
      if (attempts < succeedAfter) {
        throw new Error(`counter: attempt ${attempts} < ${succeedAfter}`);
      }
      return attempts;
    },
  };
  return { getAttempts: () => attempts, spec };
}

// ════════════════════════════════════════════════════════════════════════════
// Emitting — custom events via step.emit; stepRef pattern mirrors streaming
// ════════════════════════════════════════════════════════════════════════════

export interface EmittingConfig {
  readonly events: readonly {
    readonly name: string;
    readonly payload?: unknown;
  }[];
}

export function makeEmittingSpec(
  config: EmittingConfig,
  name = "emitting"
): { spec: StepSpec<EmittingConfig, "done">; setStep: (s: Step) => void } {
  let stepRef: Step | undefined;
  const spec: StepSpec<EmittingConfig, "done"> = {
    execute: async (input): Promise<"done"> => {
      for (const ev of input.events) {
        stepRef?.emit(ev.name, ev.payload);
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
// Bailing — terminal business failure via Bail (no retry)
// ════════════════════════════════════════════════════════════════════════════

export function makeBailingSpec<E>(
  error: E,
  name = "bailing"
): StepSpec<E, never> {
  return {
    execute: async (input) => bail(input),
    input: error,
    name,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Slow — long-running; useful for cancellation and timeout tests
// ════════════════════════════════════════════════════════════════════════════

export interface SlowConfig {
  readonly workMs: number;
}

export function makeSlowSpec(
  workMs: number,
  name = "slow"
): StepSpec<SlowConfig, "done"> {
  return {
    execute: async (input): Promise<"done"> => {
      await new Promise<void>((r) => setTimeout(r, input.workMs));
      return "done";
    },
    input: { workMs },
    name,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Inspector — captures depth at each frame; minimal (no runId/signal/path)
// ════════════════════════════════════════════════════════════════════════════

export interface InspectorConfig {
  readonly current: number;
  readonly target: number;
}

/** Per-frame capture. runId/attempt/signal/snapshot are Step-level
 * properties — read them off the Step instance after make(). */
export interface InspectionFrame {
  readonly depth: number;
}

export function makeInspectorSpec(
  target: number,
  captured: InspectionFrame[],
  opts: { sleepMs?: number } = {},
  baseName = "inspector"
): StepSpec<InspectorConfig, "done"> {
  function level(current: number): StepSpec<InspectorConfig, "done"> {
    return {
      children: (current < target
        ? [level(current + 1)]
        : []) as readonly StepSpec[],
      execute: async (input, ctx): Promise<"done"> => {
        captured.push({ depth: input.current });
        if (opts.sleepMs && opts.sleepMs > 0) {
          await new Promise<void>((r) => setTimeout(r, opts.sleepMs));
        }
        const [first] = ctx.children;
        if (input.current >= input.target || !first) {
          return "done";
        }
        return first.run({
          current: input.current + 1,
          target: input.target,
        }) as Promise<"done">;
      },
      input: { current, target },
      name: current === 0 ? baseName : `${baseName}-level-${current}`,
    };
  }
  return level(0);
}
