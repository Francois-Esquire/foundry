import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { Models } from "../../models";

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

const { codexModels, codexProvider } = await import("../../node/codex");
const { fromCodexListing } = await import("../../node/codex/listing");

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
  )
);

describe("fromCodexListing", () => {
  it("declares tool calling on every row", () => {
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

describe("codexModels", () => {
  const binPath = "/configured/codex";

  it("resolves a live family numerically without changing the provider default or exact IDs", async () => {
    listModels.mockResolvedValueOnce({
      models: [
        { id: "gpt-6.2-sol" },
        { id: "gpt-6.10-sol", model: "gpt-6.10-sol" },
        { id: "gpt-5.6-sol", isDefault: true },
        { hidden: true, id: "gpt-9.0-sol" },
        { id: "gpt-8-sol", model: "other-model" },
        { id: "gpt-7-sol-fast" },
        { id: "gpt-7-sol-preview" },
        { id: "gpt-7-preview" },
        { id: "custom", name: "GPT-10 Sol" },
      ],
    });
    const rows = await codexModels({ binPath, env });
    const manager = new Models({
      providers: [
        codexProvider({ config: { available: true }, env, models: [...rows] }),
      ],
    });
    using family = manager.resolve("text", "codex/sol");
    expect(manager.available("codex/sol")).toBe(true);
    expect(family.definition.modelId).toBe("gpt-6.10-sol");
    await family.open().doGenerate(CALL);
    expect(languageModel).toHaveBeenLastCalledWith("gpt-6.10-sol", {});
    expect(manager.resolve("text").model).toBe("gpt-5.6-sol");
    expect(
      manager.resolve("text", "codex/gpt-6.2-sol").definition.modelId
    ).toBe("gpt-6.2-sol");
    expect(manager.available("codex/gpt-7-sol-fast")).toBe(true);
    expect(manager.available("codex/gpt-7-sol-preview")).toBe(true);
    expect(manager.available("codex/gpt-6.3-sol")).toBe(false);
    expect(manager.available("codex/luna")).toBe(false);
    expect(manager.available("codex/preview")).toBe(false);
  });

  it("keeps an exact family name and avoids guessing between equally ranked stable IDs", async () => {
    listModels.mockResolvedValueOnce({
      models: [
        { id: "gpt-6.10-sol" },
        { id: "sol" },
        { id: "gpt-6.10-terra" },
        { id: "gpt-6.10.0-terra" },
        { id: "gpt-6.2-terra" },
        { id: "gpt-6.10-luna" },
        { id: "gpt-6.10.0-luna" },
        { id: "gpt-7-luna" },
      ],
    });
    const rows = await codexModels({ binPath, env });
    expect(
      rows.filter(({ id }) => id === "sol").map(({ modelId }) => modelId)
    ).toEqual(["sol"]);
    expect(rows.some(({ id }) => id === "terra")).toBe(false);
    expect(rows.find(({ id }) => id === "luna")?.modelId).toBe("gpt-7-luna");
  });

  it("lists with the configured account, closes the client, and puts the reported default first", async () => {
    close.mockClear();
    listModels.mockResolvedValueOnce({
      models: [{ id: "other" }, { id: "preferred", isDefault: true }],
    });
    const languageCalls = languageModel.mock.calls.length;
    const account = {
      ...Object.fromEntries(
        Object.entries(env).filter(([key]) => key !== "OPENAI_API_KEY")
      ),
      CODEX_HOME: "/configured",
    };
    vi.stubEnv("OPENAI_API_KEY", "ambient-test-key");
    vi.stubEnv("CODEX_HOME", "/ambient");
    try {
      const rows = await codexModels({
        binPath,
        env: account,
      });
      expect(rows.map((row) => row.id)).toEqual(["preferred", "other"]);
      expect(createCodexAppServer).toHaveBeenLastCalledWith({
        defaultSettings: {
          codexPath: binPath,
          env: { CODEX_HOME: "/configured", OPENAI_API_KEY: "" },
          logger: false,
        },
      });
      expect(languageModel).toHaveBeenCalledTimes(languageCalls);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses to discover against an implicit OS login", async () => {
    createCodexAppServer.mockClear();
    await expect(codexModels({ binPath, env: {} })).rejects.toThrow(
      "Codex discovery requires HOME or CODEX_HOME in the provider environment"
    );
    expect(createCodexAppServer).not.toHaveBeenCalled();
  });

  it("closes a failed listing and keeps CLI diagnostics out of the error message", async () => {
    close.mockClear();
    listModels.mockRejectedValueOnce(new Error("secret in CLI stderr"));
    await expect(codexModels({ binPath, env })).rejects.toMatchObject({
      message: "Codex app-server could not list models",
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes an in-flight listing on abort and ignores its late result", async () => {
    close.mockClear();
    const pending = Promise.withResolvers<{ models: { id: string }[] }>();
    const started = Promise.withResolvers<void>();
    listModels.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const controller = new AbortController();
    const listing = codexModels({ binPath, env, signal: controller.signal });
    await started.promise;
    controller.abort(new Error("listing cancelled"));
    await expect(listing).rejects.toThrow("listing cancelled");
    pending.resolve({ models: [{ id: "late" }] });
    expect(close).toHaveBeenCalledTimes(1);
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
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<{ content: [] }>();
    doGenerate.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const provider = codexProvider({ env });
    const model = provider.languageModel("gpt-5.5");
    const running = model.doGenerate(CALL);
    await started.promise;

    process.env.MARBLES_CODEX_DRIFT = "late";
    try {
      await model.doGenerate(CALL);
    } finally {
      delete process.env.MARBLES_CODEX_DRIFT;
    }
    expect(createCodexAppServer).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();

    pending.resolve({ content: [] });
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

  it("has an empty catalog without supplied models", () => {
    expect(codexProvider({ env }).models).toEqual([]);
  });
});
