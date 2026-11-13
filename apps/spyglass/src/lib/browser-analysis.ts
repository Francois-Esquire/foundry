// The browser analysis asset's entry: everything a page needs to scan a
// public GitHub repository in the browser and read the result. Built by
// `scripts/build.ts` into one self-contained module (TypeScript, ts-morph
// and dependency-cruiser included, over the private in-memory `node:fs` of
// `scripts/browser-cruise-adapter.ts`), which the scan page loads by URL
// on its first scan. Nothing in the viewer imports this file; the page
// imports only its types.

export type { DatasetTransport } from "./dataset";
export type { DatasetAnalysis } from "./dataset-analysis";
export type { FileMapDataset } from "./file-map-dataset";
export type {
  FileMapScanner,
  FileMapScanProgress,
} from "./file-map-scanner";
// biome-ignore lint/performance/noBarrelFile: the browser analysis asset's entry point.
export {
  createFileMapScanner,
  FileMapScanAbortedError,
} from "./file-map-scanner";
export { RepositoryAcquisitionError } from "./github-loader";
export type {
  GitHubRepositoryScan,
  GitHubRepositoryScanInput,
} from "./repository-scan";
export { scanGitHubRepository } from "./repository-scan";
