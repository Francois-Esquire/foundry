/**
 * `@foundry/models/local` — the on-device runtime. Importing this pulls in
 * transformers-js; the root barrel exports only the surface types, so hosts
 * reach here deliberately.
 */

export type { LocalProviderOptions } from "./provider";
export {
  configureCache,
  LOCAL_DEFAULT_MODELS,
  LOCAL_DEFAULTS,
  LocalProvider,
  modelWeightsPresent,
  toFloat32,
} from "./provider";
export type {
  ForkedLocalWorker,
  ForkLocalWorkerOptions,
  HostTransport,
  RemoteLocalProviderOptions,
  WorkerReply,
  WorkerRequest,
  WorkerTransport,
} from "./remote";
export { forkLocalWorker, RemoteLocalProvider, runLocalWorker } from "./remote";
export type {
  LocalDownloadProgress,
  LocalFileProgress,
  LocalLoadedModel,
  LocalLoadState,
  LocalLoadStatus,
  LocalModelDefinition,
  LocalProviderSurface,
} from "./surface";
export { isLocalProvider } from "./surface";
