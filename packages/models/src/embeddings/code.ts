import type { Chunk, CodeChunkerBackend } from "@chonkiejs/core";

import { CodeChunker } from "@chonkiejs/core";
import { modelErrors } from "../errors";
import type { ChunkSource } from "./source";
import { streamFrom } from "./source";

/**
 * Structure-aware code chunking backed by `@chonkiejs/core`'s {@link CodeChunker}.
 *
 * Unlike the recursive/semantic chunkers (which split prose-ish text), this
 * parses source with tree-sitter and cuts on syntactic structure — function and
 * class boundaries rather than blind size windows. Returned chunks carry the
 * native chonkie fields (`text`, `startIndex`, `endIndex`, `tokenCount`); at a
 * realistic `chunkSize` coverage round-trips (`text.slice(start,end) === text`).
 *
 * **Grammars download on demand.** tree-sitter grammars are *not* bundled — the
 * first chunk of a given language fetches its grammar from the network into a
 * local cache (`@kreuzberg/tree-sitter-language-pack`). The wrapper auto-fetches
 * by default; for offline/sandboxed runs, pre-warm with
 * {@link downloadCodeLanguages} (e.g. at startup) or pass `skipDownload` and
 * manage grammars yourself. A custom `backend` is assumed to manage its own
 * grammars, so it never triggers a download.
 *
 * **`"auto"` needs a prior warm.** Auto-detection picks among *already
 * downloaded* grammars; with nothing cached it has nothing to detect. Warm the
 * languages you expect first, or pass an explicit language.
 */
export type { Chunk, CodeChunkerBackend } from "@chonkiejs/core";

export interface CodeChunkOptions {
  /**
   * Custom tree-sitter backend. When provided, the wrapper does not auto-download
   * (the backend owns its grammars). Defaults to the kreuzberg language pack.
   */
  backend?: CodeChunkerBackend;
  /** Maximum tokens per chunk (character tokenizer ⇒ ≈ chars). Default 512. */
  chunkSize?: number;
  /** Skip the auto-download step; the caller guarantees the grammar is present. */
  skipDownload?: boolean;
}

/** Default code chunk size (tokens). */
export const DEFAULT_CODE_CHUNK_SIZE = 512;

// One in-flight download promise per language, so concurrent first-chunks of the
// same language don't double-fetch. Cleared on failure so a transient error can
// be retried.
const downloads = new Map<string, Promise<void>>();

/**
 * Ensure tree-sitter grammars for `languages` are downloaded and cached. Call at
 * startup to make later {@link codeChunk} calls offline-safe. `"auto"` is
 * skipped (it names no grammar to fetch).
 */
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
    // This is a native CJS module. When it's loaded as an external dependency
    // in a bundled context (e.g. Electron's main process), Node's CJS
    // named-export detection misses its runtime-assigned exports, so they only
    // surface under `.default`. Normalize both shapes.
    const pack = (mod as unknown as { default?: typeof mod }).default ?? mod;
    if (pack.downloadedLanguages().includes(language)) {
      return;
    }
    // `download` is a synchronous, blocking native call returning a count.
    pack.download([language]);
  } catch (cause) {
    downloads.delete(language); // allow a later retry after a transient failure
    const error = modelErrors.CODE_GRAMMAR_DOWNLOAD_FAILED({ language });
    error.cause = cause;
    throw error;
  }
}

/** Build a {@link CodeChunker} for `language`, auto-downloading its grammar by default. */
export async function createCodeChunker(
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

/** One-shot: chunk `text` as `language` source on tree-sitter structure boundaries. */
export async function codeChunk(
  text: string,
  language: string,
  options: CodeChunkOptions = {}
): Promise<Chunk[]> {
  const chunker = await createCodeChunker(language, options);
  // CodeChunker.chunk is synchronous once the chunker is built.
  return chunker.chunk(text);
}

/**
 * Stream code chunks from a {@link ChunkSource}. Buffers the whole source first
 * (tree-sitter parses the complete file) — see {@link streamFrom}.
 */
export function codeChunkStream(
  input: ChunkSource,
  language: string,
  options: CodeChunkOptions = {}
): AsyncGenerator<Chunk> {
  return streamFrom(input, (text) => codeChunk(text, language, options));
}
