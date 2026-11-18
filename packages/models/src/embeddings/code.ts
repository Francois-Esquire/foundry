import type { Chunk, CodeChunkerBackend } from "@chonkiejs/core";

import { CodeChunker } from "@chonkiejs/core";
import { modelErrors } from "../errors";
import type { ChunkSource } from "./source";
import { streamFrom } from "./source";

export type { Chunk } from "@chonkiejs/core";

export interface CodeChunkOptions {
  backend?: CodeChunkerBackend;
  chunkSize?: number;
  skipDownload?: boolean;
}

const DEFAULT_CODE_CHUNK_SIZE = 512;

const downloads = new Map<string, Promise<void>>();

export function downloadCodeLanguages(languages: string[]): Promise<void> {
  const targets = [...new Set(languages.filter((l) => l && l !== "auto"))];
  return Promise.all(targets.map(ensureLanguage)).then(() => undefined);
}

function ensureLanguage(language: string): Promise<void> {
  let inflight = downloads.get(language);
  if (!inflight) {
    inflight = fetchLanguage(language);
    downloads.set(language, inflight);
  }
  return inflight;
}

async function fetchLanguage(language: string): Promise<void> {
  try {
    const mod = await import("@kreuzberg/tree-sitter-language-pack");
    const pack = (mod as unknown as { default?: typeof mod }).default ?? mod;
    if (pack.downloadedLanguages().includes(language)) {
      return;
    }
    pack.download([language]);
  } catch (cause) {
    downloads.delete(language);
    const error = modelErrors.CODE_GRAMMAR_DOWNLOAD_FAILED({ language });
    error.cause = cause;
    throw error;
  }
}

async function createCodeChunker(
  language: string,
  options: CodeChunkOptions = {}
): Promise<CodeChunker> {
  if (!(options.backend || options.skipDownload) && language !== "auto") {
    await ensureLanguage(language);
  }
  return CodeChunker.create({
    chunkSize: options.chunkSize ?? DEFAULT_CODE_CHUNK_SIZE,
    language,
    ...(options.backend ? { backend: options.backend } : {}),
  });
}

export async function codeChunk(
  text: string,
  language: string,
  options: CodeChunkOptions = {}
): Promise<Chunk[]> {
  const chunker = await createCodeChunker(language, options);
  return chunker.chunk(text);
}

export function codeChunkStream(
  input: ChunkSource,
  language: string,
  options: CodeChunkOptions = {}
): AsyncGenerator<Chunk> {
  return streamFrom(input, (text) => codeChunk(text, language, options));
}
