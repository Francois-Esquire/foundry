import { z } from "zod";

// INTERNAL: what an analysis outside a native scan could and could not see,
// saved with the dataset it produced. A native scan writes no such artifact,
// so its manifest and files are unchanged; a dataset assembled from a file
// map writes one at `DATASET_ANALYSIS_FILE`, a fixed path the manifest does
// not name (as history's manifest), and the reader's `analysis()` returns it
// verified. Unavailable facts stay explicit: nothing here is inferred from
// which artifacts exist, and nothing claims a capability is complete.
//
// The metadata restates facts the manifest also records, and the two must
// agree, both before assembly writes the metadata and when a reader loads
// it. Agreement is consistency between documents, not authenticity: a
// reader cannot establish where a map was placed, only that the metadata
// does not contradict the manifest saved beside it.

/** An import dependency-cruiser could not resolve to a file. */
interface UnresolvedSpecifier {
  /** Root-relative POSIX path of the importing module. */
  from: string;
  specifier: string;
}

/**
 * What the file-map preparation could and could not establish, returned
 * with every result. Unavailable is never reported as empty or zero.
 */
export interface FileMapCapabilities {
  configuration: {
    /** Config modules (`*.config.*`) present in the map; parsed by nothing, executed never. */
    configModules: string[];
    /**
     * What the program's compiler still reports about the tsconfig. An
     * explicit tsconfig the cruise's TypeScript rejects (an `extends` the
     * map cannot answer, an invalid option) refuses the map, as natively.
     */
    diagnostics: string[];
    executed: false;
    /** A root `tsconfig.json` present but not named by the `tsconfig` option, which native analysis also ignores. */
    unusedRootTsconfig: boolean;
    tsconfig: string | null;
  };
  history: {
    available: false;
    reason: "not-git-repository";
    detail: "A file map carries no Git history.";
  };
  moduleGraph: {
    /** Native derivation's cruise, over the map in the isolated engine's private volume. */
    source: "dependency-cruiser";
    unresolved: UnresolvedSpecifier[];
  };
  paths: { root: string; semantics: "posix" };
  types: {
    /**
     * Global diagnostics such as a declared `types` entry with no
     * declaration, then a declaration's relative import (TS2307) or
     * `/// <reference path>` (TS6053) to a file the map lacks.
     */
    diagnostics: string[];
    policy: "explicit-declarations-and-bundled-libs";
    suppliedDeclarations: string[];
    /** `types` as analyzed: the tsconfig's own, or `[]`. */
    typesOption: string[];
    typesOptionSource: "tsconfig" | "policy-empty";
    /**
     * Bare specifiers the program cannot resolve from the map's sources or
     * the supplied declarations they reach: no declaration, alias or ambient
     * module provides them.
     */
    unresolvedPackages: string[];
  };
}

/** An import a recovery-era program graph could not resolve, by edge kind. */
interface RecordedUnresolvedSpecifier extends UnresolvedSpecifier {
  kind: string;
}

/**
 * The module graph versions 1 and 2 recorded: built from the TypeScript
 * program, with dependency-cruiser named only as the native counterpart.
 * Read as saved, never relabelled as a cruise.
 */
interface RecordedProgramModuleGraph {
  edgeKinds: readonly string[];
  /** Workspace modules a cruise would scan that the program did not contain. */
  modulesOutsideProgram: string[];
  nativeSource: "dependency-cruiser";
  source: "typescript-program";
  unresolved: RecordedUnresolvedSpecifier[];
  unsupportedEdgeKinds: readonly string[];
}

/** Capabilities as versions 1 and 2 saved them. */
type RecordedFileMapCapabilities = Omit<FileMapCapabilities, "moduleGraph"> & {
  moduleGraph: RecordedProgramModuleGraph;
};

/** Facts about the assembly itself, beside the analysis's capabilities. */
export interface DatasetAssemblyProvenance {
  /**
   * Whether the manifest records an inputs fingerprint. Without one, a
   * currency check reports the dataset `unrecorded`.
   */
  inputsFingerprint: "recorded" | "unrecorded";
  /**
   * In-memory assembly derives no internals: the manifest names none, and
   * the reader's `internals` raises its existing "saved without internals"
   * error.
   */
  internals: "not-assembled";
}

/** Where the analysed sources came from: a file map supplied as data. */
interface FileMapAnalysisOrigin {
  /** The generation command the manifest also records. */
  command: string;
  /** A recorded repository file map, placed under `root`. */
  kind: "file-map";
  /** The POSIX root the map's paths were placed under. */
  root: string;
}

/**
 * The public GitHub repository revision a loader read, by coordinates the
 * GitHub API returned. Nothing here is a credential: no token, userinfo or
 * query string is ever recorded.
 */
export interface GitHubRepositorySource {
  /** The repository's default branch when it was resolved. */
  defaultBranch: string;
  host: "github.com";
  /** The owner as the API spells it (its canonical case, after renames). */
  owner: string;
  /**
   * How the requested ref was taken: the default branch (no ref requested),
   * a full commit SHA, or a name GitHub resolved (branch, tag or short SHA;
   * GitHub chooses when a branch and a tag share the name).
   */
  refKind: "commit-sha" | "default-branch" | "named";
  /** The repository as the API spells it. */
  repo: string;
  /** The ref as requested, or null for the default branch. */
  requestedRef: string | null;
  /** The full, lowercase commit SHA every listing and download used. */
  resolvedCommit: string;
  /** The repository-relative directory analysed as the root, or null for the whole repository. */
  scope: string | null;
}

/** Why a listed entry was not placed in the file map. */
export interface RepositoryAcquisitionOmissions {
  /** Files with a NUL byte: binary content, not text. */
  binary: string[];
  /** Committed files below `node_modules/`; dependency sources are never read. */
  nodeModules: string[];
  /** The count of files outside the analysis-input policy (images, docs, data, ...), never downloaded. */
  notAnalysisInput: number;
  /** Files whose bytes are not valid UTF-8. */
  notUtf8: string[];
  /** Gitlinks (mode 160000); submodule contents are never fetched. */
  submodules: string[];
  /** Symbolic links (mode 120000); their targets are never followed. */
  symlinks: string[];
  /** Files over the single-file limit, with their listed sizes, never downloaded. */
  tooLarge: { path: string; size: number }[];
}

/** Numeric guardrails one acquisition ran under. Provisional, not product support claims. */
export interface RepositoryAcquisitionLimits {
  concurrency: number;
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  maxTreeEntries: number;
}

/**
 * Fixed statements of what this acquisition cannot establish, saved so a
 * reader never mistakes their absence for completeness.
 */
const REPOSITORY_ACQUISITION_LIMITATIONS = [
  /** The repository's Git history was not fetched. */
  "history-not-fetched",
  /** Byte checks compare each download with GitHub's own listing; GitHub's TLS is the only trust anchor. */
  "integrity-is-listing-consistency",
  /** No dependency was installed or fetched; only declarations a caller supplies resolve. */
  "dependencies-not-installed",
  /** Only public repositories, without credentials. */
  "public-repositories-only",
  /** With a scope, files outside it (such as a root lockfile or tsconfig) were not read. */
  "outside-scope-not-read",
  /** A named ref is resolved by GitHub, which picks between a branch and a tag of the same name. */
  "named-ref-resolved-by-github",
] as const;

export type RepositoryAcquisitionLimitation =
  (typeof REPOSITORY_ACQUISITION_LIMITATIONS)[number];

/** How the loader obtained the bytes, and what it left out. */
export interface RepositoryAcquisition {
  /** Each download's length and Git blob SHA-1 equal the listing's; consistency with GitHub, not independent authenticity. */
  integrity: "git-blob-sha1-matches-listing";
  limitations: RepositoryAcquisitionLimitation[];
  limits: RepositoryAcquisitionLimits;
  omissions: RepositoryAcquisitionOmissions;
  /** The only origins contacted: GitHub's REST API and raw content host. */
  origins: ["https://api.github.com", "https://raw.githubusercontent.com"];
  /** Files placed in the map, and their total bytes. */
  read: { bytes: number; files: number };
}

/** A public GitHub revision loaded in the browser, placed under `root`. */
export interface GitHubRepositoryAnalysisOrigin {
  acquisition: RepositoryAcquisition;
  /** The generation command the manifest also records. */
  command: string;
  kind: "github-repository";
  repository: GitHubRepositorySource;
  /** `githubRepositoryRoot(owner, repo, scope)`. */
  root: string;
}

export type DatasetAnalysisOrigin =
  | FileMapAnalysisOrigin
  | GitHubRepositoryAnalysisOrigin;

/** Version 1: a file map, with a recorded program graph. Read only. */
interface DatasetAnalysisV1 {
  capabilities: RecordedFileMapCapabilities;
  origin: FileMapAnalysisOrigin;
  provenance: DatasetAssemblyProvenance;
  schemaVersion: 1;
}

/** Version 2 added a loaded public GitHub repository as an origin. Read only. */
interface DatasetAnalysisV2 {
  capabilities: RecordedFileMapCapabilities;
  origin: GitHubRepositoryAnalysisOrigin;
  provenance: DatasetAssemblyProvenance;
  schemaVersion: 2;
}

/** Version 3: the module graph is dependency-cruiser's cruise, for either origin. */
interface DatasetAnalysisV3 {
  capabilities: FileMapCapabilities;
  origin: DatasetAnalysisOrigin;
  provenance: DatasetAssemblyProvenance;
  schemaVersion: 3;
}

/**
 * Saved analysis metadata. Only version 3 is written; versions 1 and 2 are
 * read exactly as saved, so a recorded program graph keeps its provenance.
 */
export type DatasetAnalysis =
  | DatasetAnalysisV1
  | DatasetAnalysisV2
  | DatasetAnalysisV3;

/** The version every assembly writes. */
export const DATASET_ANALYSIS_SCHEMA_VERSION = 3;

/**
 * The virtual root a loaded GitHub revision is placed under, so the
 * manifest's `workspace.root` (the last segment) is the repository's name,
 * or the scope's last directory.
 */
export function githubRepositoryRoot(
  owner: string,
  repo: string,
  scope: string | null
): string {
  return `/github/${owner}/${repo}${scope === null ? "" : `/${scope}`}`;
}

/** GitHub's owner rule: alphanumerics and single inner hyphens, at most 39. */
export const GITHUB_OWNER =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** GitHub's repository-name characters, at most 100, never `.` or `..`. */
export const GITHUB_REPO = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
/** A full, lowercase Git object ID. */
export const GIT_SHA = /^[0-9a-f]{40}$/;

/** How a requested ref is taken: none is the default branch, a full SHA is pinned, anything else GitHub resolves. */
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

const recordedCapabilitiesSchema = capabilitiesSchema.extend({
  moduleGraph: z.strictObject({
    edgeKinds: strings.readonly(),
    modulesOutsideProgram: strings,
    nativeSource: z.literal("dependency-cruiser"),
    source: z.literal("typescript-program"),
    unresolved: z.array(
      z.strictObject({
        from: z.string(),
        kind: z.string(),
        specifier: z.string(),
      })
    ),
    unsupportedEdgeKinds: strings.readonly(),
  }),
}) satisfies z.ZodType<RecordedFileMapCapabilities>;

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

const analysisSchema = z.discriminatedUnion("schemaVersion", [
  z.strictObject({
    capabilities: recordedCapabilitiesSchema,
    origin: fileMapOriginSchema,
    provenance: provenanceSchema,
    schemaVersion: z.literal(1),
  }),
  z.strictObject({
    capabilities: recordedCapabilitiesSchema,
    origin: githubOriginSchema,
    provenance: provenanceSchema,
    schemaVersion: z.literal(2),
  }),
  z.strictObject({
    capabilities: capabilitiesSchema,
    origin: z.discriminatedUnion("kind", [
      fileMapOriginSchema,
      githubOriginSchema,
    ]),
    provenance: provenanceSchema,
    schemaVersion: z.literal(DATASET_ANALYSIS_SCHEMA_VERSION),
  }),
]) satisfies z.ZodType<DatasetAnalysis>;

/** The saved analysis metadata must be valid when a dataset has it. */
export function verifyDatasetAnalysis(value: unknown): DatasetAnalysis {
  const result = analysisSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      "The dataset's analysis metadata is unreadable or uses an unsupported schema version. Build the dataset again."
    );
  }
  return result.data;
}

/**
 * The manifest facts the metadata restates; a `DatasetManifest` has them,
 * and so does an assembly's input before its manifest exists.
 */
export interface DatasetAnalysisManifestFacts {
  generation: { command: string; inputs?: unknown };
  packages: readonly { id: string; internals?: string }[];
  workspace: { root: string };
}

/**
 * Every way `analysis` contradicts `manifest`, empty when they agree:
 *
 * - `origin.root` is `capabilities.paths.root`, the root the map's paths
 *   were placed under.
 * - That root's last POSIX segment is the manifest's `workspace.root`,
 *   which records the last segment of the assembled root. File-map roots
 *   are normalized POSIX absolute directories other than `/`
 *   (`capabilities.paths.semantics`), so the text after the last `/` is
 *   their POSIX basename.
 * - `origin.command` is the manifest's `generation.command`.
 * - `provenance.inputsFingerprint` is `recorded` exactly when the manifest's
 *   generation records inputs.
 * - `provenance.internals: "not-assembled"`: no manifest package names
 *   internals.
 */
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

/**
 * A loaded repository's coordinates must agree with each other: the root
 * is the one its owner, repository and scope give, and the requested ref
 * matches how it was taken.
 */
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

/** Saved metadata must agree with the manifest saved beside it. */
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
