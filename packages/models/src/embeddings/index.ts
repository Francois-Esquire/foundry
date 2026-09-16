// chonkie-backed chunking (recursive + semantic). The native chonkie chunk is
// surfaced as `ChonkieChunk` to avoid colliding with the legacy `Chunk` above;
// it becomes the canonical `Chunk` once the home-brew chunker is retired.
export type { Chunk as ChonkieChunk } from "@chonkiejs/core";
export type { Chunk, ChunkSpan, ChunkStrategy } from "./chunk";
export { chunk, countNewlines } from "./chunk";
export type { CodeChunkerBackend, CodeChunkOptions } from "./code";
export {
  codeChunk,
  codeChunkStream,
  createCodeChunker,
  DEFAULT_CODE_CHUNK_SIZE,
  downloadCodeLanguages,
} from "./code";
export type {
  ChunkMethod,
  EmbedChunksOptions,
  EmbeddedChunk,
} from "./pipeline";
export { embedChunks } from "./pipeline";
export type { RecursiveChunkOptions } from "./recursive";
export {
  createRecursiveChunker,
  DEFAULT_RECURSIVE_CHUNK_SIZE,
  recursiveChunk,
  recursiveChunkStream,
} from "./recursive";
export type {
  EmbeddingModel,
  EmbedFunction,
  SemanticChunkOptions,
} from "./semantic";
export {
  createSemanticChunker,
  DEFAULT_SEMANTIC_CHUNK_SIZE,
  semanticChunk,
  semanticChunkStream,
  toEmbedFunction,
} from "./semantic";
export type { ChunkSource } from "./source";
export { collectSource, streamFrom } from "./source";
export type { ScoredCandidate } from "./text";
export {
  cosineSimilarity,
  deserializeEmbedding,
  embed,
  embedFields,
  embedViaPipeline,
  rankBySimilarity,
  serializeEmbedding,
  topK,
} from "./text";
export type {
  EmbeddingPayload,
  EmbedFieldInput,
  EmbedFieldsOptions,
  EmbedOptions,
  EmbedSource,
} from "./types";
