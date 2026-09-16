import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type {
  HostTransport,
  WorkerReply,
  WorkerRequest,
  WorkerSideTransport,
} from "../local/remote";
import { RemoteLocalProvider, runLocalWorker } from "../local/remote";
import type { LocalProviderSurface } from "../local/surface";
import { ModelManager } from "../manager";
import { fakeProvider } from "./helpers/model";

/** Cross-wired in-memory transports: what one side sends, the other receives. */
function makeTransportPair() {
  const toWorker = new EventEmitter();
  const toHost = new EventEmitter();
  let exitHost: ((reason: string) => void) | null = null;

  const host: HostTransport = {
    onExit: (h) => {
      exitHost = h;
    },
    onMessage: (h) => {
      toHost.on("message", h);
    },
    send: (m: WorkerRequest) => toWorker.emit("message", m),
  };
  const worker: WorkerSideTransport = {
    onExit: () => undefined,
    onMessage: (h) => {
      toWorker.on("message", h);
    },
    send: (m: WorkerReply) => toHost.emit("message", m),
  };
  return { host, killWorker: (reason: string) => exitHost?.(reason), worker };
}

/**
 * A structural stand-in for the worker's LocalProvider: real enough for the
 * bridge (models, transcribe, status, events), fake enough to assert on.
 */
function makeFakeProvider() {
  const seenSignals: AbortSignal[] = [];
  const events = new EventEmitter();
  const fake = {
    download: vi.fn(() => Promise.resolve()),
    embeddingModel: () => ({
      doEmbed: (options: { values: string[] }) =>
        Promise.resolve({
          embeddings: options.values.map(() => [0.1, 0.2]),
          warnings: [],
        }),
      maxEmbeddingsPerCall: undefined,
      modelId: "fake-embed",
      provider: "local",
      specificationVersion: "v4" as const,
      supportsParallelCalls: false,
    }),
    events,
    languageModel: (modelId: string) => ({
      doGenerate: (options: { abortSignal?: AbortSignal }) => {
        if (options.abortSignal) {
          seenSignals.push(options.abortSignal);
        }
        return Promise.resolve({
          content: [{ text: "generated", type: "text" }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          warnings: [],
        });
      },
      doStream: (options: { abortSignal?: AbortSignal }) => {
        if (options.abortSignal) {
          seenSignals.push(options.abortSignal);
        }
        return Promise.resolve({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ delta: "a", id: "t", type: "text-delta" });
              controller.enqueue({ delta: "b", id: "t", type: "text-delta" });
              controller.enqueue({
                finishReason: "stop",
                type: "finish",
                usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
              });
              controller.close();
            },
          }),
        });
      },
      modelId: `fake-${modelId}`,
      provider: "local",
      specificationVersion: "v4" as const,
      supportedUrls: {},
    }),
    preload: vi.fn(() => Promise.resolve()),
    progress: () => 0.5,
    seenSignals,
    setOffline: vi.fn(),
    status: () => ({ progress: 1, state: "ready" as const }),
    transcribe: vi.fn((audio: Float32Array) =>
      Promise.resolve({ segments: [], text: `heard ${audio.length} samples` })
    ),
  };
  return fake;
}

function makeBridge() {
  const { host, worker, killWorker } = makeTransportPair();
  const fake = makeFakeProvider();
  // Structural stand-in at the test boundary — the worker only calls the
  // methods the fake implements.
  runLocalWorker(worker, fake as unknown as LocalProviderSurface);
  const provider = new RemoteLocalProvider({ transport: host });
  return { fake, killWorker, provider };
}

const callOptions = {
  prompt: [
    { content: [{ text: "hi", type: "text" as const }], role: "user" as const },
  ],
};

describe("remote-local bridge", () => {
  it("doGenerate round-trips the result", async () => {
    const { provider } = makeBridge();
    const result = await provider.languageModel("m").doGenerate(callOptions);
    expect(result.content).toEqual([{ text: "generated", type: "text" }]);
    expect(result.usage.outputTokens).toBe(2);
  });

  it("doStream forwards every part in order, then closes", async () => {
    const { provider } = makeBridge();
    const { stream } = await provider.languageModel("m").doStream(callOptions);
    const parts: unknown[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      parts.push(value);
    }
    expect(parts).toEqual([
      { delta: "a", id: "t", type: "text-delta" },
      { delta: "b", id: "t", type: "text-delta" },
      {
        finishReason: "stop",
        type: "finish",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    ]);
  });

  it("doEmbed round-trips embeddings", async () => {
    const { provider } = makeBridge();
    const result = await provider
      .embeddingModel("e")
      .doEmbed({ values: ["x", "y"] });
    expect(result.embeddings).toEqual([
      [0.1, 0.2],
      [0.1, 0.2],
    ]);
  });

  it("transcribe carries audio across as the same samples", async () => {
    const { provider, fake } = makeBridge();
    const audio = new Float32Array([0.25, -0.5, 1]);
    const result = await provider.transcribe(audio);
    expect(result.text).toBe("heard 3 samples");
    const received = fake.transcribe.mock.calls[0]?.[0];
    expect([...(received ?? [])]).toEqual([0.25, -0.5, 1]);
  });

  it("host abort reaches the worker model's signal", async () => {
    const { provider, fake } = makeBridge();
    const abort = new AbortController();
    const { stream } = await provider
      .languageModel("m")
      .doStream({ ...callOptions, abortSignal: abort.signal });
    void stream; // parts already emitted; the signal was captured at call time
    abort.abort();
    expect(fake.seenSignals[0]?.aborted).toBe(true);
  });

  it("worker errors reject the host call with the message", async () => {
    const { provider, fake } = makeBridge();
    fake.download.mockRejectedValueOnce(new Error("no disk"));
    await expect(provider.download("text")).rejects.toThrow("no disk");
  });

  it("forwards provider events across the bridge", () => {
    const { provider, fake } = makeBridge();
    const seen = vi.fn();
    provider.events.on("download-progress", seen);
    fake.events.emit("download-progress", { modelId: "m", progress: 40 });
    expect(seen).toHaveBeenCalledWith({ modelId: "m", progress: 40 });
  });

  it("worker exit rejects in-flight calls and fails later ones fast", async () => {
    const { host, killWorker } = makeTransportPair(); // no worker attached
    const provider = new RemoteLocalProvider({ transport: host });
    const inFlight = provider.download("text");
    killWorker("crashed");
    await expect(inFlight).rejects.toThrow(/worker exited: crashed/);
    expect(provider.workerLost).toBe(true);
    await expect(provider.download("text")).rejects.toThrow(/worker exited/);
  });
});

describe("manager integration", () => {
  it("fills the local role: transcription and progress route to the bridge", async () => {
    const { provider } = makeBridge();
    const manager = new ModelManager({ providers: [provider] });

    const local = manager.local;
    expect(local).toBe(provider);
    if (!local) {
      throw new Error("expected the local role");
    }
    const result = await local.transcribe(new Float32Array(4));
    expect(result.text).toBe("heard 4 samples");
    expect(local.progress("embed")).toBeNull(); // cache warms async
  });

  it("Airplane Mode routes inference to the worker-backed local role", async () => {
    const { provider } = makeBridge();
    // The decoy claims `offline: true` and is registered first, so a
    // "first offline provider wins" policy would resolve to it.
    const cloud = fakeProvider("cloud", { offline: true });
    const manager = new ModelManager({ providers: [cloud, provider] });
    manager.setOfflineMode(true);

    const result = await manager.model().doGenerate(callOptions);
    const embeddings = await manager.embedding().doEmbed({ values: ["x"] });

    expect(result.content).toEqual([{ text: "generated", type: "text" }]);
    expect(embeddings.embeddings).toEqual([[0.1, 0.2]]);
    expect(manager.defaultProviderFor("text")).toBe("local");
    expect(cloud.calls).toEqual([]);
  });

  it("crosses the process boundary when Airplane Mode toggles", () => {
    const { provider, fake } = makeBridge();
    const manager = new ModelManager({ providers: [provider] });

    manager.setOfflineMode(true);
    expect(fake.setOffline).toHaveBeenCalledWith(true);
    manager.setOfflineMode(false);
    expect(fake.setOffline).toHaveBeenCalledWith(false);
  });

  it("fails closed when the local worker is gone — no cloud fallback", async () => {
    const { host, killWorker } = makeTransportPair(); // no worker attached
    const provider = new RemoteLocalProvider({ transport: host });
    const cloud = fakeProvider("cloud", { offline: true });
    const manager = new ModelManager({ providers: [cloud, provider] });
    manager.setOfflineMode(true);
    killWorker("crashed");

    await expect(manager.model().doGenerate(callOptions)).rejects.toThrow(
      /worker exited: crashed/
    );
    expect(provider.workerLost).toBe(true);
    expect(() => manager.model(undefined, "cloud")).toThrow(/Airplane Mode/);
    expect(cloud.calls).toEqual([]);
  });
});
