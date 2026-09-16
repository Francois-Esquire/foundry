import { describe, expect, it, vi } from "vitest";

/**
 * The SDK is stubbed wholesale: every test here is about our own gating and
 * mapping, and none of them should ever spawn a `codex app-server`.
 */
const listModels = vi.fn();
const close = vi.fn(() => Promise.resolve());
const languageModel = vi.fn((modelId: string) => ({ modelId }));
const createCodexAppServer = vi.fn(
  (_options?: { defaultSettings?: { codexPath?: string } }) => ({
    close,
    languageModel,
    listModels,
  })
);

vi.mock("ai-sdk-provider-codex-cli", () => ({ createCodexAppServer }));

const { CODEX_DEFAULT_MODELS, codexProvider } = await import("../codex");
const { fromCodexListing } = await import("../catalog/codex");
const { ModelManager } = await import("../manager");

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
    expect(codexProvider().available).toBe(false);
  });

  it("never spawns the CLI when the harness is unavailable", async () => {
    listModels.mockClear();
    expect(await codexProvider().discover?.()).toEqual([]);
    expect(listModels).not.toHaveBeenCalled();
  });

  it("discovers over the static floor once available", async () => {
    listModels.mockResolvedValueOnce({
      models: [{ id: "gpt-5.6-sol", name: "GPT-5.6-Sol" }],
    });
    const provider = codexProvider({ config: { available: true } });
    const manager = new ModelManager({ providers: [provider] });
    await manager.init();

    const ids = provider.models.map((m) => m.id);
    expect(ids).toEqual(["gpt-5.6-sol"]);
  });

  it("keeps serving its floor when the CLI fails", async () => {
    listModels.mockRejectedValueOnce(new Error("codex not responding"));
    const provider = codexProvider({ config: { available: true } });
    await new ModelManager({ providers: [provider] }).init();
    expect(provider.models.map((m) => m.id)).toEqual(["gpt-5.5"]);
  });

  it("names itself as the harness that runs the turn", () => {
    expect(codexProvider().harness).toBe("codex");
  });

  it("mounts a turn-scoped working directory when it builds the model", () => {
    codexProvider().languageModel("gpt-5.5", { workingDirectory: "/repo" });
    expect(languageModel).toHaveBeenLastCalledWith("gpt-5.5", {
      cwd: "/repo",
    });
  });

  it("hands the resolved binary path to the CLI transport", () => {
    createCodexAppServer.mockClear();
    codexProvider({ config: { binPath: "/opt/homebrew/bin/codex" } });
    expect(
      createCodexAppServer.mock.calls[0]?.[0]?.defaultSettings?.codexPath
    ).toBe("/opt/homebrew/bin/codex");
  });

  it("rebuilds the transport when configured with a binary path", () => {
    createCodexAppServer.mockClear();
    const provider = codexProvider();
    provider.configure?.({ available: true, binPath: "/bin/codex" });
    expect(provider.available).toBe(true);
    expect(
      createCodexAppServer.mock.calls.at(-1)?.[0]?.defaultSettings?.codexPath
    ).toBe("/bin/codex");
  });

  it("stops the child process on dispose", async () => {
    close.mockClear();
    await codexProvider().dispose?.();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("ships a floor that survives the catalog's own capability filter", () => {
    for (const model of CODEX_DEFAULT_MODELS) {
      expect(model.kind).toBe("text");
      expect(model.capabilities?.functionCalling).toBe(true);
    }
  });
});
