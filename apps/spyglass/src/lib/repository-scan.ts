import type { FileMapDataset, FileMapDatasetInput } from "./file-map-dataset";
import type { FileMapScanner, FileMapScanOptions } from "./file-map-scanner";
import type {
  GitHubLoadOptions,
  LoadedGitHubRepository,
} from "./github-loader";
import { loadGitHubRepository } from "./github-loader";
import type { GitHubRepositoryInput } from "./github-request";
import { parseGitHubRepositoryInput } from "./github-request";

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
  acquisitionTiming: LoadedGitHubRepository["timing"];

  dataset: FileMapDataset;
}

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
        readGeneratedJavaScript: input.tsconfig !== undefined,
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
