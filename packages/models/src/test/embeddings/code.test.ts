import type { CodeChunkerBackend } from "@chonkiejs/core";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDownload = vi.fn();
const mockDownloadedLanguages = vi.fn<() => string[]>(() => []);

vi.mock("@kreuzberg/tree-sitter-language-pack", () => {
  const mod = {
    download: mockDownload,
    downloadedLanguages: mockDownloadedLanguages,
  };
  // The wrapper normalizes both CJS named-export and `.default` shapes; mirror
  // that here so the mock matches either access pattern.
  return { ...mod, default: mod };
});

const { codeChunk, codeChunkStream, downloadCodeLanguages } = await import(
  "../../embeddings/code"
);

beforeEach(() => {
  mockDownload.mockReset();
  // `download` is synchronous and returns the count of grammars fetched.
  mockDownload.mockReturnValue(1);
  mockDownloadedLanguages.mockReset();
  mockDownloadedLanguages.mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A fake tree-sitter backend: splits the source into N equal byte ranges. Lets
// the wrapper be tested offline — a custom backend bypasses grammar downloads.
function fakeBackend(parts = 3): CodeChunkerBackend {
  return {
    detectLanguageFromContent: () => "fakelang",
    downloadedLanguages: () => ["fakelang"],
    hasLanguage: () => true,
    process: (source: string) => {
      const size = Math.ceil(source.length / parts);
      const chunks = [];
      for (let i = 0; i < source.length; i += size) {
        chunks.push({
          content: source.slice(i, i + size),
          endByte: Math.min(i + size, source.length),
          startByte: i,
        });
      }
      return {
        chunks,
        imports: [],
        metrics: { errorCount: 0, totalLines: source.split("\n").length },
        structure: [],
      };
    },
  };
}

const SRC = "function a() {}\nfunction b() {}\nfunction c() {}\n";

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) {
    out.push(item);
  }
  return out;
}

async function* asAsyncStream(text: string, size = 8): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) {
    await Promise.resolve();
    yield text.slice(i, i + size);
  }
}

// ── downloadCodeLanguages — the grammar-fetch lifecycle ──────────────────────

describe("downloadCodeLanguages", () => {
  it("fetches each missing language and skips the 'auto' placeholder", async () => {
    await downloadCodeLanguages(["lang-a", "auto", "lang-a"]);
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(mockDownload).toHaveBeenCalledWith(["lang-a"]);
  });

  it("does not re-fetch a language already downloaded", async () => {
    mockDownloadedLanguages.mockReturnValue(["lang-present"]);
    await downloadCodeLanguages(["lang-present"]);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("memoizes in-flight downloads — concurrent calls fetch once", async () => {
    await Promise.all([
      downloadCodeLanguages(["lang-concurrent"]),
      downloadCodeLanguages(["lang-concurrent"]),
    ]);
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it("wraps a fetch failure with context and stays retryable", async () => {
    mockDownload.mockImplementationOnce(() => {
      throw new Error("network down");
    });
    await expect(downloadCodeLanguages(["lang-flaky"])).rejects.toThrow(
      /grammar/i
    );
    // The in-flight memo was cleared, so a retry attempts the fetch again
    // (falling back to the base mock, which succeeds).
    await expect(
      downloadCodeLanguages(["lang-flaky"])
    ).resolves.toBeUndefined();
    expect(mockDownload).toHaveBeenCalledTimes(2);
  });
});

// ── codeChunk / codeChunkStream — wrapper behavior (fake backend) ────────────

describe("codeChunk", () => {
  it("chunks via the injected backend and round-trips offsets", async () => {
    const chunks = await codeChunk(SRC, "fakelang", {
      backend: fakeBackend(3),
    });
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.text).join("")).toBe(SRC);
    for (const c of chunks) {
      expect(SRC.slice(c.startIndex, c.endIndex)).toBe(c.text);
      expect(c.tokenCount).toBeGreaterThan(0);
    }
  });

  it("does not auto-download when a custom backend is supplied", async () => {
    await codeChunk(SRC, "fakelang", { backend: fakeBackend() });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("does not auto-download when skipDownload is set", async () => {
    await codeChunk(SRC, "fakelang", {
      backend: fakeBackend(),
      skipDownload: true,
    });
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

describe("codeChunkStream", () => {
  it("streams from a source identically to the one-shot result", async () => {
    const opts = { backend: fakeBackend(2) };
    const oneShot = await codeChunk(SRC, "fakelang", opts);
    const streamed = await collect(
      codeChunkStream(asAsyncStream(SRC), "fakelang", opts)
    );
    expect(streamed).toEqual(oneShot);
  });
});
