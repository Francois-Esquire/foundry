import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

/**
 * The SDK is stubbed wholesale: every test here is about our own gating and
 * mapping, and none of them should ever spawn a `codex app-server`.
 */
interface Settings {
  codexPath?: string;
  env?: Record<string, string>;
}

const listModels = vi.fn();
const close = vi.fn(() => Promise.resolve());
const doGenerate = vi.fn(() => Promise.resolve({ content: [] }));
const languageModel = vi.fn(
  (modelId: string, _settings?: { cwd?: string }): object => ({
    client: { child: undefined },
    doGenerate,
    modelId,
  })
);
const createCodexAppServer = vi.fn(
  (_options?: { defaultSettings?: Settings }) => ({
    close,
    languageModel,
    listModels,
  })
);

vi.mock("ai-sdk-provider-codex-cli", () => ({ createCodexAppServer }));

const CALL = { prompt: [] } as never;

const { CODEX_DEFAULT_MODELS, codexProvider } = await import("../codex");
const { fromCodexListing } = await import("../catalog/codex");

/** The ambient environment itself, so the overlay each model gets is empty. */
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
  )
);

describe("fromCodexListing", () => {
  it("declares tool calling on every row", () => {
    // Not detected — stated. The selectable catalog filters on this exact flag,
    // so a row without it vanishes from the picker with no error to explain it.
    const rows = fromCodexListing([
      { id: "gpt-5.5", name: "GPT-5.5" },
      { id: "gpt-5.3-codex", modelProvider: "openai" },
    ]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.capabilities?.functionCalling).toBe(true);
      expect(row.kind).toBe("text");
      expect(row.modelId).toBe(row.id);
    }
  });

  it("falls back to the id when the CLI reports no display name", () => {
    const [row] = fromCodexListing([{ id: "gpt-5.5", name: null }]);
    expect(row?.label).toBe("gpt-5.5");
  });

  it("skips entries with no usable id rather than inventing one", () => {
    expect(fromCodexListing([{ id: "" }, { id: "ok" }])).toHaveLength(1);
  });
});

describe("codexProvider", () => {
  it("is unavailable until the host says otherwise", () => {
    expect(codexProvider({ env }).available).toBe(false);
  });

  it("declares that it cannot enforce a turn limit", () => {
    expect(codexProvider({ env }).turnLimit).toBe("unsupported");
  });

  it("starts its app-server with the environment it was given", async () => {
    createCodexAppServer.mockClear();
    process.env.MARBLES_CODEX_SECRET = "workspace";
    try {
      await codexProvider({ env }).languageModel("gpt-5.5").doGenerate(CALL);
    } finally {
      delete process.env.MARBLES_CODEX_SECRET;
    }
    expect(
      createCodexAppServer.mock.calls.at(-1)?.[0]?.defaultSettings?.env
    ).toEqual({ MARBLES_CODEX_SECRET: "" });
  });

  it("mounts a turn-scoped working directory on each call", async () => {
    createCodexAppServer.mockClear();
    await codexProvider({ env })
      .languageModel("gpt-5.5", { workingDirectory: "/repo" })
      .doGenerate(CALL);
    expect(languageModel).toHaveBeenLastCalledWith("gpt-5.5", { cwd: "/repo" });
    expect(
      createCodexAppServer.mock.calls.at(-1)?.[0]?.defaultSettings?.env
    ).toEqual({});
  });

  it("hands the resolved binary path to the CLI transport", async () => {
    createCodexAppServer.mockClear();
    await codexProvider({ config: { binPath: "/opt/homebrew/bin/codex" }, env })
      .languageModel("gpt-5.5")
      .doGenerate(CALL);
    expect(
      createCodexAppServer.mock.calls[0]?.[0]?.defaultSettings?.codexPath
    ).toBe("/opt/homebrew/bin/codex");
  });

  it("reuses one transport while nothing changes", async () => {
    createCodexAppServer.mockClear();
    const model = codexProvider({ env }).languageModel("gpt-5.5");
    await model.doGenerate(CALL);
    await model.doGenerate(CALL);
    expect(createCodexAppServer).toHaveBeenCalledTimes(1);
  });

  it("closes the old transport after the environment changes, once its call ends", async () => {
    createCodexAppServer.mockClear();
    close.mockClear();
    let finish: (value: { content: [] }) => void = () => undefined;
    doGenerate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const provider = codexProvider({ env });
    const model = provider.languageModel("gpt-5.5");
    const running = model.doGenerate(CALL);

    process.env.MARBLES_CODEX_DRIFT = "late";
    try {
      await model.doGenerate(CALL);
    } finally {
      delete process.env.MARBLES_CODEX_DRIFT;
    }
    expect(createCodexAppServer).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();

    finish({ content: [] });
    await running;
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("refuses to confirm going offline when the SDK hides its process", async () => {
    languageModel.mockImplementationOnce((modelId: string) => ({
      doGenerate,
      modelId,
    }));
    const provider = codexProvider({ env });
    await provider.languageModel("gpt-5.5").doGenerate(CALL);
    await expect(provider.setOffline?.(true)).rejects.toThrow(
      "could not confirm it went offline"
    );
  });

  it("releases a stream dropped without being read once it is collected", async () => {
    setFlagsFromString("--expose-gc");
    const collect = runInNewContext("gc") as () => void;
    close.mockClear();
    const doStream = () =>
      Promise.resolve({
        stream: new ReadableStream<string>({
          start: (controller) => controller.enqueue("part"),
        }),
      });
    languageModel.mockImplementationOnce((modelId: string) => ({
      client: { child: undefined },
      doStream,
      modelId,
    }));
    const provider = codexProvider({ env });
    await (async () => {
      await provider.languageModel("gpt-5.5").doStream(CALL);
    })();
    process.env.MARBLES_CODEX_DRIFT = "late";
    try {
      await provider.languageModel("gpt-5.5").doGenerate(CALL);
    } finally {
      delete process.env.MARBLES_CODEX_DRIFT;
    }
    expect(close).not.toHaveBeenCalled();

    await vi.waitFor(
      async () => {
        collect();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(close).toHaveBeenCalledTimes(1);
      },
      { interval: 20, timeout: 8000 }
    );
  }, 10_000);

  it("stops every transport on dispose", async () => {
    close.mockClear();
    const provider = codexProvider({ env });
    await provider.languageModel("gpt-5.5").doGenerate(CALL);
    await provider.dispose?.();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("ships a floor that survives the catalog's own capability filter", () => {
    for (const model of CODEX_DEFAULT_MODELS) {
      expect(model.kind).toBe("text");
      expect(model.capabilities?.functionCalling).toBe(true);
    }
  });
});
