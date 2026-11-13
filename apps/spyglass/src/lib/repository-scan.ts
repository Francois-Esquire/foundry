import type { FileMapDataset, FileMapDatasetInput } from "./file-map-dataset";
import type { FileMapScanner, FileMapScanOptions } from "./file-map-scanner";
import type {
  GitHubLoadOptions,
  LoadedGitHubRepository,
} from "./github-loader";
import { loadGitHubRepository } from "./github-loader";
import type { GitHubRepositoryInput } from "./github-request";
import { parseGitHubRepositoryInput } from "./github-request";

// INTERNAL composition: a public GitHub repository input to an in-memory
// dataset, through the repository loader and the existing file-map scanner.
// The scanner owns the lifecycle (one running scan, replacement, reset and
// stale-result rejection); this adds no state of its own. The input is
// normalized before the scanner is touched, so an unsupported input starts
// nothing and leaves the published result as it was. Once started, a scan
// clears the published result, as every scan does. The loaded map is
// analysed with the file-map policy (explicit declarations and bundled
// libraries only), and the repository's coordinates and what the loader
// omitted are saved with the dataset as its origin. Not a public export.

export interface GitHubRepositoryScanInput
  extends GitHubRepositoryInput,
    Pick<
      FileMapDatasetInput,
      | "command"
      | "config"
      | "declarations"
      | "exclude"
      | "now"
      | "profile"
      | "settings"
      | "tsconfig"
    > {}

export interface GitHubRepositoryScanOptions
  extends FileMapScanOptions,
    Pick<GitHubLoadOptions, "fetch" | "limits"> {}

export interface GitHubRepositoryScan {
  /** Resolution, listing and download, in wall-clock milliseconds. */
  acquisitionTiming: LoadedGitHubRepository["timing"];
  /** The published dataset; its `reader().analysis()` names the repository. */
  dataset: FileMapDataset;
}

/**
 * Scans `input`'s public GitHub revision through `scanner`. Throws
 * `RepositoryInputError` before starting for an unsupported input; rejects
 * with `RepositoryAcquisitionError` for a failed load, the scanner's abort
 * reason when replaced or reset, and analysis errors otherwise.
 */
export async function scanGitHubRepository(
  scanner: FileMapScanner,
  input: GitHubRepositoryScanInput,
  options: GitHubRepositoryScanOptions = {}
): Promise<GitHubRepositoryScan> {
  const request = parseGitHubRepositoryInput(input);
  let acquisitionTiming: LoadedGitHubRepository["timing"] | undefined;
  const dataset = await scanner.scanSource(
    async ({ report, signal }) => {
      const loaded = await loadGitHubRepository(request, {
        ...(options.fetch !== undefined && { fetch: options.fetch }),
        ...(options.limits !== undefined && { limits: options.limits }),
        onProgress: report,
        signal,
      });
      acquisitionTiming = loaded.timing;
      return {
        command: input.command ?? "scanGitHubRepository",
        ...(input.config !== undefined && { config: input.config }),
        ...(input.declarations !== undefined && {
          declarations: input.declarations,
        }),
        ...(input.exclude !== undefined && { exclude: input.exclude }),
        files: loaded.files,
        now: input.now,
        ...(input.profile !== undefined && { profile: input.profile }),
        repository: {
          acquisition: loaded.acquisition,
          repository: loaded.repository,
        },
        root: loaded.root,
        ...(input.settings !== undefined && { settings: input.settings }),
        ...(input.tsconfig !== undefined && { tsconfig: input.tsconfig }),
      };
    },
    {
      ...(options.clock !== undefined && { clock: options.clock }),
      ...(options.onProgress !== undefined && {
        onProgress: options.onProgress,
      }),
      ...(options.signal !== undefined && { signal: options.signal }),
      ...(options.yieldTask !== undefined && { yieldTask: options.yieldTask }),
    }
  );
  if (acquisitionTiming === undefined) {
    throw new Error("A repository scan published without loading its source.");
  }
  return { acquisitionTiming, dataset };
}
