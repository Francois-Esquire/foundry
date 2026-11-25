// biome-ignore lint/performance/noBarrelFile: The ./embeddings/text export key stays declared until its removal.
export {
  embed,
  embedFields,
  embedUsage,
  embedViaPipeline,
  resolveEmbeddingModel,
  runEmbed,
} from "./embed";
export type { ScoredCandidate } from "./similarity";
export {
  deserializeEmbedding,
  rankBySimilarity,
  serializeEmbedding,
  topK,
} from "./similarity";
