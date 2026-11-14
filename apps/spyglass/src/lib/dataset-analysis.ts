import { z } from "zod";

interface UnresolvedSpecifier {
  from: string;
  specifier: string;
}

export interface FileMapCapabilities {
  configuration: {
    configModules: string[];

    diagnostics: string[];
    executed: false;

    unusedRootTsconfig: boolean;
    tsconfig: string | null;
  };
  history: {
    available: false;
    reason: "not-git-repository";
    detail: "A file map carries no Git history.";
  };
  moduleGraph: {
    source: "dependency-cruiser";
    unresolved: UnresolvedSpecifier[];
  };
  paths: { root: string; semantics: "posix" };
  types: {
    diagnostics: string[];
    policy: "explicit-declarations-and-bundled-libs";
    suppliedDeclarations: string[];

    typesOption: string[];
    typesOptionSource: "tsconfig" | "policy-empty";

    unresolvedPackages: string[];
  };
}

export interface DatasetAssemblyProvenance {
  inputsFingerprint: "recorded" | "unrecorded";

  internals: "not-assembled";
}

interface FileMapAnalysisOrigin {
  command: string;

  kind: "file-map";

  root: string;
}

export interface GitHubRepositorySource {
  defaultBranch: string;
  host: "github.com";

  owner: string;

  refKind: "commit-sha" | "default-branch" | "named";

  repo: string;

  requestedRef: string | null;

  resolvedCommit: string;

  scope: string | null;
}

export interface RepositoryAcquisitionOmissions {
  binary: string[];

  nodeModules: string[];

  notAnalysisInput: number;

  notUtf8: string[];

  submodules: string[];

  symlinks: string[];

  tooLarge: { path: string; size: number }[];
}

export interface RepositoryAcquisitionLimits {
  concurrency: number;
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  maxTreeEntries: number;
}

const REPOSITORY_ACQUISITION_LIMITATIONS = [
  "history-not-fetched",

  "integrity-is-listing-consistency",

  "dependencies-not-installed",

  "public-repositories-only",

  "outside-scope-not-read",

  "named-ref-resolved-by-github",
] as const;

export type RepositoryAcquisitionLimitation =
  (typeof REPOSITORY_ACQUISITION_LIMITATIONS)[number];

export interface RepositoryAcquisition {
  integrity: "git-blob-sha1-matches-listing";
  limitations: RepositoryAcquisitionLimitation[];
  limits: RepositoryAcquisitionLimits;
  omissions: RepositoryAcquisitionOmissions;

  origins: ["https://api.github.com", "https://raw.githubusercontent.com"];

  read: { bytes: number; files: number };
}

export interface GitHubRepositoryAnalysisOrigin {
  acquisition: RepositoryAcquisition;

  command: string;
  kind: "github-repository";
  repository: GitHubRepositorySource;

  root: string;
}

export type DatasetAnalysisOrigin =
  | FileMapAnalysisOrigin
  | GitHubRepositoryAnalysisOrigin;

export interface DatasetAnalysis {
  capabilities: FileMapCapabilities;
  origin: DatasetAnalysisOrigin;
  provenance: DatasetAssemblyProvenance;
  schemaVersion: typeof DATASET_ANALYSIS_SCHEMA_VERSION;
}

export const DATASET_ANALYSIS_SCHEMA_VERSION = 3;

export function githubRepositoryRoot(
  owner: string,
  repo: string,
  scope: string | null
): string {
  return `/github/${owner}/${repo}${scope === null ? "" : `/${scope}`}`;
}

export const GITHUB_OWNER =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export const GITHUB_REPO = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

export const GIT_SHA = /^[0-9a-f]{40}$/;

export function refKindOf(
  requestedRef: string | null
): GitHubRepositorySource["refKind"] {
  if (requestedRef === null) {
    return "default-branch";
  }
  return GIT_SHA.test(requestedRef) ? "commit-sha" : "named";
}

const strings = z.array(z.string());

const capabilitiesSchema = z.strictObject({
  configuration: z.strictObject({
    configModules: strings,
    diagnostics: strings,
    executed: z.literal(false),
    tsconfig: z.string().nullable(),
    unusedRootTsconfig: z.boolean(),
  }),
  history: z.strictObject({
    available: z.literal(false),
    detail: z.literal("A file map carries no Git history."),
    reason: z.literal("not-git-repository"),
  }),
  moduleGraph: z.strictObject({
    source: z.literal("dependency-cruiser"),
    unresolved: z.array(
      z.strictObject({ from: z.string(), specifier: z.string() })
    ),
  }),
  paths: z.strictObject({
    root: z.string(),
    semantics: z.literal("posix"),
  }),
  types: z.strictObject({
    diagnostics: strings,
    policy: z.literal("explicit-declarations-and-bundled-libs"),
    suppliedDeclarations: strings,
    typesOption: strings,
    typesOptionSource: z.enum(["tsconfig", "policy-empty"]),
    unresolvedPackages: strings,
  }),
}) satisfies z.ZodType<FileMapCapabilities>;

const provenanceSchema = z.strictObject({
  inputsFingerprint: z.enum(["recorded", "unrecorded"]),
  internals: z.literal("not-assembled"),
}) satisfies z.ZodType<DatasetAssemblyProvenance>;

const count = z.number().int().nonnegative();
const positive = z.number().int().positive();
const relativePath = z.string().min(1);

const githubOriginSchema = z.strictObject({
  acquisition: z.strictObject({
    integrity: z.literal("git-blob-sha1-matches-listing"),
    limitations: z.array(z.enum(REPOSITORY_ACQUISITION_LIMITATIONS)),
    limits: z.strictObject({
      concurrency: positive,
      maxFileBytes: positive,
      maxFiles: positive,
      maxTotalBytes: positive,
      maxTreeEntries: positive,
    }),
    omissions: z.strictObject({
      binary: z.array(relativePath),
      nodeModules: z.array(relativePath),
      notAnalysisInput: count,
      notUtf8: z.array(relativePath),
      submodules: z.array(relativePath),
      symlinks: z.array(relativePath),
      tooLarge: z.array(z.strictObject({ path: relativePath, size: count })),
    }),
    origins: z.tuple([
      z.literal("https://api.github.com"),
      z.literal("https://raw.githubusercontent.com"),
    ]),
    read: z.strictObject({ bytes: count, files: count }),
  }),
  command: z.string(),
  kind: z.literal("github-repository"),
  repository: z.strictObject({
    defaultBranch: z.string().min(1),
    host: z.literal("github.com"),
    owner: z.string().regex(GITHUB_OWNER),
    refKind: z.enum(["commit-sha", "default-branch", "named"]),
    repo: z.string().regex(GITHUB_REPO),
    requestedRef: z.string().min(1).nullable(),
    resolvedCommit: z.string().regex(GIT_SHA),
    scope: relativePath.nullable(),
  }),
  root: z.string(),
}) satisfies z.ZodType<GitHubRepositoryAnalysisOrigin>;

const fileMapOriginSchema = z.strictObject({
  command: z.string(),
  kind: z.literal("file-map"),
  root: z.string(),
}) satisfies z.ZodType<FileMapAnalysisOrigin>;

const analysisSchema = z.strictObject({
  capabilities: capabilitiesSchema,
  origin: z.discriminatedUnion("kind", [
    fileMapOriginSchema,
    githubOriginSchema,
  ]),
  provenance: provenanceSchema,
  schemaVersion: z.literal(DATASET_ANALYSIS_SCHEMA_VERSION),
}) satisfies z.ZodType<DatasetAnalysis>;

export function verifyDatasetAnalysis(value: unknown): DatasetAnalysis {
  const result = analysisSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      "The dataset's analysis metadata is unreadable or uses an unsupported schema version. Build the dataset again."
    );
  }
  return result.data;
}

export interface DatasetAnalysisManifestFacts {
  generation: { command: string; inputs?: unknown };
  packages: readonly { id: string; internals?: string }[];
  workspace: { root: string };
}

export function datasetAnalysisProblems(
  analysis: DatasetAnalysis,
  manifest: DatasetAnalysisManifestFacts
): string[] {
  const { capabilities, origin, provenance } = analysis;
  const problems: string[] = [];
  if (origin.root !== capabilities.paths.root) {
    problems.push(
      `origin.root ${JSON.stringify(origin.root)} is not capabilities.paths.root ${JSON.stringify(capabilities.paths.root)}`
    );
  }
  const segment = origin.root.slice(origin.root.lastIndexOf("/") + 1);
  if (segment !== manifest.workspace.root) {
    problems.push(
      `origin.root ${JSON.stringify(origin.root)} ends in ${JSON.stringify(segment)}, but the manifest's workspace.root is ${JSON.stringify(manifest.workspace.root)}`
    );
  }
  if (origin.command !== manifest.generation.command) {
    problems.push(
      `origin.command ${JSON.stringify(origin.command)} is not the manifest's generation.command ${JSON.stringify(manifest.generation.command)}`
    );
  }
  const recorded = manifest.generation.inputs !== undefined;
  if ((provenance.inputsFingerprint === "recorded") !== recorded) {
    problems.push(
      `provenance.inputsFingerprint is ${JSON.stringify(provenance.inputsFingerprint)}, but the manifest's generation records ${recorded ? "inputs" : "no inputs"}`
    );
  }
  const internals = manifest.packages
    .filter((pkg) => pkg.internals !== undefined)
    .map((pkg) => pkg.id);
  if (internals.length > 0) {
    problems.push(
      `provenance.internals is ${JSON.stringify(provenance.internals)}, but the manifest names internals for ${internals.join(", ")}`
    );
  }
  if (origin.kind === "github-repository") {
    problems.push(...repositoryOriginProblems(origin));
  }
  return problems;
}

function repositoryOriginProblems(
  origin: GitHubRepositoryAnalysisOrigin
): string[] {
  const { repository } = origin;
  const problems: string[] = [];
  const root = githubRepositoryRoot(
    repository.owner,
    repository.repo,
    repository.scope
  );
  if (origin.root !== root) {
    problems.push(
      `origin.root ${JSON.stringify(origin.root)} is not ${JSON.stringify(root)}, the root of its repository and scope`
    );
  }
  const kind = refKindOf(repository.requestedRef);
  if (repository.refKind !== kind) {
    problems.push(
      `repository.refKind is ${JSON.stringify(repository.refKind)}, but the requested ref makes it ${JSON.stringify(kind)}`
    );
  }
  if (
    repository.refKind === "commit-sha" &&
    repository.requestedRef !== repository.resolvedCommit
  ) {
    problems.push(
      "repository.resolvedCommit is not the commit SHA that was requested"
    );
  }
  return problems;
}

export function verifyDatasetAnalysisCorrespondence(
  analysis: DatasetAnalysis,
  manifest: DatasetAnalysisManifestFacts
): DatasetAnalysis {
  const problems = datasetAnalysisProblems(analysis, manifest);
  if (problems.length > 0) {
    throw new Error(
      `The dataset's analysis metadata contradicts its manifest: ${problems.join("; ")}. Build the dataset again.`
    );
  }
  return analysis;
}
