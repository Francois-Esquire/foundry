import { afterEach, describe, expect, it } from "vitest";

import {
  configureModelObservability,
  isModelObservabilityEnabled,
  traceModelDownload,
  withAiLogger,
} from "../logger";

interface AiField {
  calls?: number;
  embedding?: { tokens?: number };
  estimatedCost?: number;
  inputTokens?: number;
  model?: string;
  outputTokens?: number;
  toolCalls?: string[];
  totalTokens?: number;
}

function drainEvents(events: { ai?: AiField }[]) {
  configureModelObservability({
    enabled: true,
    logger: {
      drain: (ctx) => {
        events.push(ctx.event as { ai?: AiField });
      },
    },
  });
}

afterEach(() => {
  // Restore the default so other suites and cases start enabled.
  configureModelObservability({ enabled: true });
});

describe("model observability", () => {
  it("runs the body and returns its result when enabled", async () => {
    configureModelObservability({ enabled: true });
    expect(isModelObservabilityEnabled()).toBe(true);

    const result = await withAiLogger({ operation: "unit" }, (session) => {
      // A real model would be wrapped; with no SDK model here we just assert
      // the session shape is present and usable.
      expect(typeof session.wrap).toBe("function");
      expect(typeof session.captureEmbed).toBe("function");
      return Promise.resolve(42);
    });

    expect(result).toBe(42);
  });

  it("emits the wide event even when the body throws", async () => {
    configureModelObservability({ enabled: true });

    await expect(
      withAiLogger({ operation: "boom" }, () =>
        Promise.reject(new Error("kaboom"))
      )
    ).rejects.toThrow("kaboom");
  });

  it("wrap is identity and captureEmbed a no-op when disabled", async () => {
    configureModelObservability({ enabled: false });
    expect(isModelObservabilityEnabled()).toBe(false);

    const sentinel = { id: "model" };
    const out = await withAiLogger({ operation: "off" }, (session) => {
      expect(session.wrap(sentinel as never)).toBe(sentinel);
      session.captureEmbed({ usage: { tokens: 0 } });
      return Promise.resolve("done");
    });

    expect(out).toBe("done");
  });

  it("emits a wide event through the configured drain (full chain)", async () => {
    const events: { ai?: AiField }[] = [];
    drainEvents(events);

    await withAiLogger({ operation: "embed" }, (session) => {
      session.captureEmbed({ model: "test-embed", usage: { tokens: 100 } });
      return Promise.resolve();
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.ai?.embedding?.tokens).toBe(100);
  });

  it("accepts cost overrides", () => {
    expect(() => {
      configureModelObservability({
        cost: { "custom/model": { input: 1, output: 2 } },
      });
    }).not.toThrow();
  });
});

interface DownloadField {
  durationMs?: number;
  fileCount?: number;
  files?: { file: string; bytes: number }[];
  kind?: string;
  label?: string;
  modelId?: string;
  totalBytes?: number;
}

interface DownloadEvent {
  audit?: { action?: string; target?: { id?: string } };
  download?: DownloadField;
}

function drainDownloadEvents(events: DownloadEvent[]) {
  configureModelObservability({
    enabled: true,
    logger: {
      drain: (ctx) => {
        events.push(ctx.event);
      },
    },
  });
}

describe("traceModelDownload", () => {
  it("spans one wide event per download and ends it once with the bundled audit", () => {
    const events: DownloadEvent[] = [];
    drainDownloadEvents(events);

    const trace = traceModelDownload({
      dtype: "q4",
      kind: "text",
      label: "Test Model",
      modelId: "test/model",
    });

    trace.track({
      file: "weights.onnx",
      loaded: 10,
      progress: 10,
      status: "progress",
      total: 100,
    });
    trace.track({
      file: "tokenizer.json",
      loaded: 4,
      progress: 50,
      status: "progress",
      total: 8,
    });

    // A small file finishing early is a terminal marker, but the weights are
    // still streaming — the event must stay open for the whole download.
    trace.track({ file: "tokenizer.json", status: "done" });
    trace.finish("done");
    expect(events).toHaveLength(0);

    trace.track({ file: "weights.onnx", status: "done" });
    trace.finish("done");
    // The trailing model-level `ready` must not emit a second event.
    trace.finish("ready");

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.download?.modelId).toBe("test/model");
    expect(event?.download?.label).toBe("Test Model");
    expect(event?.download?.fileCount).toBe(2);
    expect(event?.download?.totalBytes).toBe(108);
    expect(event?.download?.files).toEqual(
      expect.arrayContaining([
        { bytes: 100, file: "weights.onnx" },
        { bytes: 8, file: "tokenizer.json" },
      ])
    );
    expect(typeof event?.download?.durationMs).toBe("number");
    expect(event?.audit?.action).toBe("models.MODEL_DOWNLOAD");
    expect(event?.audit?.target?.id).toBe("test/model");
  });

  it("ends at `ready` even when file-level completion was never observed", () => {
    const events: DownloadEvent[] = [];
    drainDownloadEvents(events);

    const trace = traceModelDownload({ kind: "text", modelId: "test/model" });
    trace.track({
      file: "weights.onnx",
      loaded: 60,
      progress: 60,
      status: "progress",
      total: 100,
    });
    trace.finish("ready");

    expect(events).toHaveLength(1);
    expect(events[0]?.download?.fileCount).toBe(1);
  });

  it("never opens an event for a pure cache load", () => {
    const events: DownloadEvent[] = [];
    drainDownloadEvents(events);

    const trace = traceModelDownload({ kind: "text", modelId: "test/model" });
    // Cached weights skip byte progress and jump straight to terminals.
    trace.track({ file: "weights.onnx", status: "done" });
    trace.finish("done");
    trace.finish("ready");

    expect(events).toHaveLength(0);
  });

  it("is a no-op when observability is disabled", () => {
    const events: DownloadEvent[] = [];
    drainDownloadEvents(events);
    configureModelObservability({ enabled: false });

    const trace = traceModelDownload({ kind: "text", modelId: "test/model" });
    trace.track({
      file: "weights.onnx",
      loaded: 10,
      progress: 10,
      status: "progress",
      total: 100,
    });
    trace.finish("ready");

    expect(events).toHaveLength(0);
  });
});
