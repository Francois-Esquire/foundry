import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The probe reads `env.cacheDir` at call time; the mock lets each test point
// it at a fabricated cache fixture without touching the real configureCache
// once-guard.
const mockEnv: { cacheDir?: string } = {};
vi.mock("@huggingface/transformers", () => ({
  env: mockEnv,
  pipeline: vi.fn(),
}));

vi.mock("@browser-ai/transformers-js", () => ({
  transformersJS: {
    embeddingModel: vi.fn(),
    languageModel: vi.fn(),
    transcriptionModel: vi.fn(),
  },
}));

vi.mock("../logger", () => ({
  recordAudit: vi.fn(),
  SYSTEM_ACTOR: { id: "models", type: "system" },
  traceModelDownload: vi.fn(() => ({ finish: vi.fn(), track: vi.fn() })),
}));

const { LOCAL_DEFAULT_MODELS, LocalProvider } = await import("../local");

const upstreamId = (catalogId: string): string => {
  const row = LOCAL_DEFAULT_MODELS.find((m) => m.id === catalogId);
  if (!row) {
    throw new Error(`Missing catalog row "${catalogId}"`);
  }
  return row.modelId;
};

/** Lay down a model dir inside the fixture cache with the given files. */
async function seedModel(
  cacheDir: string,
  modelId: string,
  files: Record<string, string>
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(cacheDir, modelId, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

describe("LocalProvider downloaded probe", () => {
  let cacheDir: string;
  let provider: InstanceType<typeof LocalProvider>;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "local-probe-"));
    mockEnv.cacheDir = cacheDir;
    provider = new LocalProvider();
  });

  afterEach(async () => {
    await rm(cacheDir, { force: true, recursive: true });
  });

  it("reports downloaded when config.json and a non-empty weight exist", async () => {
    await seedModel(cacheDir, upstreamId("embed"), {
      "config.json": "{}",
      "onnx/model_quantized.onnx": "weights",
    });
    await expect(provider.isDownloaded("embed")).resolves.toBe(true);
  });

  it("reports not downloaded when the model dir is missing", async () => {
    await expect(provider.isDownloaded("embed")).resolves.toBe(false);
  });

  it("reports not downloaded when the only weight file is empty", async () => {
    await seedModel(cacheDir, upstreamId("embed"), {
      "config.json": "{}",
      "onnx/model_quantized.onnx": "",
    });
    await expect(provider.isDownloaded("embed")).resolves.toBe(false);
  });

  it("reports not downloaded when config.json is missing", async () => {
    await seedModel(cacheDir, upstreamId("embed"), {
      "onnx/model_quantized.onnx": "weights",
    });
    await expect(provider.isDownloaded("embed")).resolves.toBe(false);
  });

  it("accepts weights outside an onnx/ subdir", async () => {
    await seedModel(cacheDir, upstreamId("transcribe"), {
      "config.json": "{}",
      "encoder_model.onnx": "weights",
    });
    await expect(provider.isDownloaded("transcribe")).resolves.toBe(true);
  });

  it("returns false for unknown catalog ids", async () => {
    await expect(provider.isDownloaded("nope")).resolves.toBe(false);
  });

  it("returns false when no cache dir is configured", async () => {
    mockEnv.cacheDir = undefined;
    await expect(provider.isDownloaded("embed")).resolves.toBe(false);
  });

  it("downloadedModels lists only rows with weights on disk", async () => {
    await seedModel(cacheDir, upstreamId("embed"), {
      "config.json": "{}",
      "onnx/model_quantized.onnx": "weights",
    });
    await seedModel(cacheDir, upstreamId("transcribe"), {
      "config.json": "{}",
      "onnx/decoder_model_merged.onnx": "weights",
      "onnx/encoder_model.onnx": "weights",
    });
    await expect(provider.downloadedModels()).resolves.toEqual([
      "embed",
      "transcribe",
    ]);
  });
});
