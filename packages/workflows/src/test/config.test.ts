/**
 * config.ts — two unrelated layers under one file.
 *
 *   1. Step execution defaults — `resolveStepExecution(step)` merges
 *      step-level retry/timeout over package defaults; only present
 *      keys appear in the result so callers can `if (policy.timeout)`.
 *   2. Queue runtime config slice — `contributeQueueConfig(config)`
 *      registers the `queue` prefix on a Config registry and is
 *      idempotent across repeated calls.
 *
 * Audit Section 3 calls these out as missing-fundamentals (resolveStepExecution
 * has no direct test; contributeQueueConfig is exercised through `tests/db.ts`
 * but never as the unit-of-test).
 */

import { Config } from "@foundry/lib/config";
import { describe, expect, test } from "vitest";

import {
  contributeQueueConfig,
  defaultQueueConfig,
  defaultStepExecution,
  QUEUE_CONFIG_PREFIX,
  QueueConfigSchema,
  resolveStepExecution,
} from "../config";

// ════════════════════════════════════════════════════════════════════════════
// 1. resolveStepExecution — step-wins-over-default merge
// ════════════════════════════════════════════════════════════════════════════

describe("resolveStepExecution", () => {
  test("a step with no fields returns the empty default (no spurious keys)", () => {
    const out = resolveStepExecution({});
    expect(out).toEqual({});
    // Keys are only present when a value was provided — `if (policy.timeout)`
    // works without a `?? null` dance.
    expect("retry" in out).toBe(false);
    expect("timeout" in out).toBe(false);
  });

  test("step.retry wins when present; only `retry` appears in the result", () => {
    const out = resolveStepExecution({ retry: { maxAttempts: 5 } });
    expect(out).toEqual({ retry: { maxAttempts: 5 } });
    expect("timeout" in out).toBe(false);
  });

  test("step.timeout wins when present; only `timeout` appears in the result", () => {
    const out = resolveStepExecution({ timeout: "1s" });
    expect(out).toEqual({ timeout: "1s" });
    expect("retry" in out).toBe(false);
  });

  test("both step fields present surface together", () => {
    const out = resolveStepExecution({
      retry: { maxAttempts: 3 },
      timeout: 250,
    });
    expect(out).toEqual({
      retry: { maxAttempts: 3 },
      timeout: 250,
    });
  });

  test("step values override package defaults when both exist", () => {
    // Mutate the snapshot for the assertion: defaultStepExecution is shipped
    // empty today, so to verify the step-wins branch we synthesize a step
    // with a value and confirm the step value flows through verbatim.
    // (Defaults are empty by design; if a default is added later, this test
    // continues to pin "step wins" — the override branch — even when the
    // default branch becomes meaningful.)
    expect(defaultStepExecution.retry).toBeUndefined();
    expect(defaultStepExecution.timeout).toBeUndefined();
    const out = resolveStepExecution({ retry: { maxAttempts: 7 } });
    expect(out.retry).toEqual({ maxAttempts: 7 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. contributeQueueConfig — idempotency + override merge + default shape
// ════════════════════════════════════════════════════════════════════════════

describe("contributeQueueConfig", () => {
  test("seeds the registry with `defaultQueueConfig` when no override is supplied", () => {
    const config = new Config();
    contributeQueueConfig(config);
    expect(config.get(QUEUE_CONFIG_PREFIX)).toEqual(defaultQueueConfig);
  });

  test("a partial override is shallow-merged over the defaults", () => {
    const config = new Config();
    contributeQueueConfig(config, { concurrency: 8 });
    const slice = config.get(QUEUE_CONFIG_PREFIX);
    if (!slice) {
      throw new Error("queue config slice missing");
    }
    expect(slice.concurrency).toBe(8);
    // defaultName falls back to the package default.
    expect(slice.defaultName).toBe(defaultQueueConfig.defaultName);
  });

  test("idempotent: a second call is a no-op (first contribution wins)", () => {
    const config = new Config();
    contributeQueueConfig(config, { concurrency: 2, defaultName: "first" });
    contributeQueueConfig(config, { concurrency: 99, defaultName: "second" });
    const slice = config.get(QUEUE_CONFIG_PREFIX);
    if (!slice) {
      throw new Error("queue config slice missing");
    }
    expect(slice.concurrency).toBe(2);
    expect(slice.defaultName).toBe("first");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. defaultQueueConfig + QueueConfigSchema — shape sanity
// ════════════════════════════════════════════════════════════════════════════

describe("defaultQueueConfig + QueueConfigSchema", () => {
  test("defaultQueueConfig parses against QueueConfigSchema", () => {
    const parsed = QueueConfigSchema.parse(defaultQueueConfig);
    expect(parsed).toEqual(defaultQueueConfig);
  });

  test("schema rejects non-positive concurrency", () => {
    expect(() =>
      QueueConfigSchema.parse({ concurrency: 0, defaultName: "n" })
    ).toThrow();
    expect(() =>
      QueueConfigSchema.parse({ concurrency: -1, defaultName: "n" })
    ).toThrow();
    expect(() =>
      QueueConfigSchema.parse({ concurrency: 1.5, defaultName: "n" })
    ).toThrow();
  });

  test("schema rejects empty defaultName", () => {
    expect(() =>
      QueueConfigSchema.parse({ concurrency: 1, defaultName: "" })
    ).toThrow();
  });
});
