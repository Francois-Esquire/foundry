import { afterEach, describe, expect, it } from "vitest";
import { configureModelObservability } from "../../../observability";
import { traceModelDownload } from "../../../providers/local/download-trace";

afterEach(() => {
  configureModelObservability({ enabled: true });
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

    trace.track({ file: "tokenizer.json", status: "done" });
    trace.finish("done");
    expect(events).toHaveLength(0);

    trace.track({ file: "weights.onnx", status: "done" });
    trace.finish("done");
    trace.finish("ready");

    expect(events).toHaveLength(1);
    const [event] = events;
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
