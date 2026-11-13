import { sha1 } from "@noble/hashes/legacy.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { request as octokitRequest } from "@octokit/request";
import { RequestError } from "@octokit/request-error";
import type {
  GitHubRepositorySource,
  RepositoryAcquisition,
  RepositoryAcquisitionLimitation,
  RepositoryAcquisitionLimits,
  RepositoryAcquisitionOmissions,
} from "./dataset-analysis";
import {
  GIT_SHA,
  GITHUB_OWNER,
  GITHUB_REPO,
  githubRepositoryRoot,
  refKindOf,
} from "./dataset-analysis";
import { collisionProblems, pathProblems } from "./file-map-preparation";
import type { GitHubRepositoryRequest } from "./github-request";

// INTERNAL: loads one public GitHub revision into a repository file map,
// entirely from the calling page. Only two origins are contacted, both of
// which answer cross-origin requests from any page
// (`Access-Control-Allow-Origin: *`):
//
// - GitHub's REST API, through Octokit's request client, three calls a
//   scan: the repository (canonical names, visibility, default branch), the
//   ref's full commit SHA (`application/vnd.github.sha`), and the recursive
//   tree at that commit. Unauthenticated, these count against GitHub's 60
//   requests an hour per network address, so files are never fetched
//   through the API.
// - raw.githubusercontent.com, one request per analysis input, a bounded
//   number at a time, each naming the resolved commit, so a branch that
//   moves mid-load changes nothing.
//
// Archives (codeload.github.com) and Git's smart HTTP protocol are not
// readable cross-origin, and no proxy is used. Nothing is retried: a rate
// limit or network failure is reported as it is. Each download is read
// through the size the listing gives it and must have the listing's Git
// blob SHA-1: consistency with GitHub's listing, not independent
// authenticity. Symlinks, submodules, binaries, non-UTF-8 and oversized
// files are omitted and listed, never followed. Nothing is installed or
// run. Limits are provisional guardrails, not tested support claims.

/** Provisional guardrails, not product support claims; a caller may override each. */
export interface GitHubAcquisitionLimits extends RepositoryAcquisitionLimits {
  /** Directory segments a scope may have, each one request when walking a truncated listing. */
  maxScopeDepth: number;
}

/** PROVISIONAL defaults, chosen as guardrails; no repository size is a tested claim. */
export const PROVISIONAL_GITHUB_LIMITS: Readonly<GitHubAcquisitionLimits> = {
  concurrency: 6,
  maxFileBytes: 1_000_000,
  maxFiles: 5000,
  maxScopeDepth: 16,
  maxTotalBytes: 50_000_000,
  maxTreeEntries: 100_000,
};

export type RepositoryAcquisitionProgress =
  | { phase: "resolve"; stage: "start" | "end" }
  | { entries?: number; phase: "list"; stage: "start" | "end" }
  | {
      bytes: number;
      /** Files downloaded so far. */
      done: number;
      files: number;
      phase: "download";
      stage: "start" | "progress" | "end";
    };

export interface GitHubLoadOptions {
  /** Default: the global `fetch`. Tests inject a deterministic one. */
  readonly fetch?: typeof fetch;
  readonly limits?: Partial<GitHubAcquisitionLimits>;
  readonly onProgress?: (progress: RepositoryAcquisitionProgress) => void;
  readonly signal?: AbortSignal;
}

/** A loaded revision: the file map's files and root, and where they came from. */
export interface LoadedGitHubRepository {
  acquisition: RepositoryAcquisition;
  /** Scope-relative POSIX paths to text: only the analysis inputs that loaded. */
  files: Record<string, string>;
  repository: GitHubRepositorySource;
  /** `githubRepositoryRoot(owner, repo, scope)`. */
  root: string;
  /** Wall-clock milliseconds of resolution, listing and download. */
  timing: { downloadMs: number; listMs: number; resolveMs: number };
}

export type RepositoryAcquisitionErrorCode =
  | "collision"
  | "http-error"
  | "integrity"
  | "limit-exceeded"
  | "malformed-response"
  | "missing-file"
  | "network"
  | "not-found-or-private"
  | "private-repository"
  | "rate-limited"
  | "ref-not-found"
  | "scope-not-found"
  | "truncated-listing"
  | "unexpected-origin"
  | "unsafe-path";

/**
 * Why a load failed. Messages name repository coordinates and paths only,
 * never file contents, headers or credentials.
 */
export class RepositoryAcquisitionError extends Error {
  readonly code: RepositoryAcquisitionErrorCode;
  /** For `rate-limited`: when GitHub says the limit resets, when it says so. */
  readonly resetAt: Date | undefined;
  readonly status: number | undefined;

  constructor(
    code: RepositoryAcquisitionErrorCode,
    message: string,
    details: { cause?: unknown; resetAt?: Date; status?: number } = {}
  ) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause }
    );
    this.name = "RepositoryAcquisitionError";
    this.code = code;
    this.resetAt = details.resetAt;
    this.status = details.status;
  }
}

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const SYMLINK_MODE = "120000";
const GITLINK_MODE = "160000";
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const NAMED_INPUTS = new Set([".gitignore", "bun.lock", "pnpm-workspace.yaml"]);

/**
 * The analysis-input policy: TypeScript and JavaScript modules (the latter
 * as data, for the capabilities that list them), JSON (manifests, tsconfig
 * and what they extend), `.gitignore`, `bun.lock` and `pnpm-workspace.yaml`.
 */
export function isAnalysisInput(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    SOURCE_FILE.test(name) || name.endsWith(".json") || NAMED_INPUTS.has(name)
  );
}

/** One entry of a Git tree listing, as GitHub's API gives it. */
interface TreeEntry {
  mode?: string;
  path?: string;
  sha?: string;
  size?: number;
  type?: string;
}

interface Listing {
  tree: TreeEntry[];
  truncated: boolean;
}

interface Context {
  fetch: typeof fetch;
  limits: GitHubAcquisitionLimits;
  request: typeof octokitRequest;
  signal: AbortSignal | undefined;
}

/**
 * GitHub's rate-limit refusal, from a 403 or 429 that says so: no requests
 * remaining, or a `Retry-After`. A plain 403 is not one.
 */
function rateLimited(
  status: number,
  header: (name: string) => string | null | undefined,
  host: string
): RepositoryAcquisitionError | undefined {
  if (status !== 403 && status !== 429) {
    return;
  }
  const retryAfter = header("retry-after") ?? undefined;
  const remaining = header("x-ratelimit-remaining");
  if (remaining !== "0" && retryAfter === undefined && status !== 429) {
    return;
  }
  const reset = Number(header("x-ratelimit-reset"));
  const resetAt =
    Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined;
  let when = "try again later";
  if (retryAfter !== undefined) {
    when = `retry after ${retryAfter} seconds`;
  } else if (resetAt !== undefined) {
    when = `it resets at ${resetAt.toISOString()}`;
  }
  return new RepositoryAcquisitionError(
    "rate-limited",
    `${host} refused the request with a rate limit (without credentials GitHub allows 60 API requests an hour per network address, and a scan makes 3); ${when}.`,
    { ...(resetAt !== undefined && { resetAt }), status }
  );
}

function networkFailure(
  host: string,
  what: string,
  cause: unknown
): RepositoryAcquisitionError {
  return new RepositoryAcquisitionError(
    "network",
    `Could not reach ${host} for ${what}: the browser is offline, the network failed, or the response was blocked cross-origin.`,
    { cause }
  );
}

/**
 * An API call through Octokit. 404 and 422 come back as `undefined` for the
 * caller to name in its own terms; a rate limit, a network failure and any
 * other status throw. The caller's abort wins over any failure.
 */
async function api<T>(
  call: () => Promise<{ data: T }>,
  what: string,
  context: Context,
  missing: readonly number[] = [404]
): Promise<T | undefined> {
  try {
    return (await call()).data;
  } catch (error) {
    context.signal?.throwIfAborted();
    if (!(error instanceof RequestError)) {
      throw error;
    }
    if (error.response === undefined) {
      throw networkFailure("api.github.com", what, error);
    }
    if (missing.includes(error.status)) {
      return;
    }
    const headers = error.response.headers as Record<string, string>;
    throw (
      rateLimited(error.status, (name) => headers[name], "api.github.com") ??
      new RepositoryAcquisitionError(
        "http-error",
        `api.github.com answered ${error.status} for ${what}.`,
        { status: error.status }
      )
    );
  }
}

const malformed = (what: string) =>
  new RepositoryAcquisitionError(
    "malformed-response",
    `GitHub's response for ${what} does not have the expected shape.`
  );

interface Resolved {
  defaultBranch: string;
  owner: string;
  repo: string;
  sha: string;
}

async function resolveRevision(
  request: GitHubRepositoryRequest,
  context: Context
): Promise<Resolved> {
  const what = `github.com/${request.owner}/${request.repo}`;
  const info = await api(
    () =>
      context.request("GET /repos/{owner}/{repo}", {
        owner: request.owner,
        repo: request.repo,
      }),
    what,
    context
  );
  if (info === undefined) {
    throw new RepositoryAcquisitionError(
      "not-found-or-private",
      `${what} was not found. Without credentials GitHub answers the same for a private repository; only public repositories are supported.`,
      { status: 404 }
    );
  }
  if (info.private) {
    throw new RepositoryAcquisitionError(
      "private-repository",
      `${what} is private; only public repositories are supported.`
    );
  }
  const [owner = "", repo = "", ...extra] = String(info.full_name).split("/");
  if (
    extra.length > 0 ||
    !GITHUB_OWNER.test(owner) ||
    !GITHUB_REPO.test(repo) ||
    typeof info.default_branch !== "string" ||
    info.default_branch === ""
  ) {
    throw malformed(what);
  }
  const ref = request.ref ?? info.default_branch;
  const refWhat = `ref ${JSON.stringify(ref)} of github.com/${owner}/${repo}`;
  // GitHub answers 422 for a ref that names no commit.
  const commit = await api(
    () =>
      context.request("GET /repos/{owner}/{repo}/commits/{ref}", {
        mediaType: { format: "sha" },
        owner,
        ref,
        repo,
      }),
    refWhat,
    context,
    [404, 422]
  );
  if (commit === undefined) {
    throw new RepositoryAcquisitionError(
      "ref-not-found",
      `No commit was found for ${refWhat}.`
    );
  }
  // The SHA media type answers plain text, which Octokit's types do not model.
  const text: unknown = commit;
  const sha = typeof text === "string" ? text.trim() : "";
  if (!GIT_SHA.test(sha)) {
    throw new RepositoryAcquisitionError(
      "malformed-response",
      `GitHub's response for ${refWhat} is not a full commit SHA.`
    );
  }
  if (GIT_SHA.test(ref) && sha !== ref) {
    throw new RepositoryAcquisitionError(
      "malformed-response",
      `GitHub resolved commit ${ref} to a different commit.`
    );
  }
  return { defaultBranch: info.default_branch, owner, repo, sha };
}

async function listTree(
  resolved: Resolved,
  tree: string,
  recursive: boolean,
  context: Context
): Promise<Listing> {
  const what = `the file listing of github.com/${resolved.owner}/${resolved.repo} at ${resolved.sha}`;
  const listing = await api(
    () =>
      context.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner: resolved.owner,
        repo: resolved.repo,
        tree_sha: tree,
        ...(recursive && { recursive: "1" }),
      }),
    what,
    context
  );
  if (
    listing === undefined ||
    !Array.isArray(listing.tree) ||
    typeof listing.truncated !== "boolean"
  ) {
    throw malformed(what);
  }
  if (listing.tree.length > context.limits.maxTreeEntries) {
    throw new RepositoryAcquisitionError(
      "limit-exceeded",
      `${what} has ${listing.tree.length} entries, over the ${context.limits.maxTreeEntries}-entry limit.`
    );
  }
  return { tree: listing.tree, truncated: listing.truncated };
}

const TRUNCATED = (scope: string | null) =>
  new RepositoryAcquisitionError(
    "truncated-listing",
    `GitHub truncated the file listing of ${scope ?? "the repository"}, so it cannot be analysed completely. Choose a smaller scope.`
  );

const SCOPE_MISSING = (scope: string) =>
  new RepositoryAcquisitionError(
    "scope-not-found",
    `The scope ${JSON.stringify(scope)} is not a directory at the resolved commit.`
  );

/**
 * The scope's entries, with scope-relative paths, never from a truncated
 * listing: when the root listing is truncated, the scope's own tree is
 * found one level at a time and listed instead.
 */
async function scopedEntries(
  resolved: Resolved,
  scope: string | null,
  context: Context
): Promise<TreeEntry[]> {
  const root = await listTree(resolved, resolved.sha, true, context);
  if (!root.truncated) {
    if (scope === null) {
      return root.tree;
    }
    if (!root.tree.some((e) => e.path === scope && e.type === "tree")) {
      throw SCOPE_MISSING(scope);
    }
    const prefix = `${scope}/`;
    return root.tree
      .filter((entry) => entry.path?.startsWith(prefix))
      .map((entry) => ({ ...entry, path: entry.path?.slice(prefix.length) }));
  }
  if (scope === null) {
    throw TRUNCATED(null);
  }
  const segments = scope.split("/");
  if (segments.length > context.limits.maxScopeDepth) {
    throw new RepositoryAcquisitionError(
      "limit-exceeded",
      `The listing was truncated and the scope has ${segments.length} segments, over the ${context.limits.maxScopeDepth}-segment walk limit.`
    );
  }
  let tree = resolved.sha;
  for (const segment of segments) {
    const level = await listTree(resolved, tree, false, context);
    const next = level.tree.find(
      (entry) => entry.path === segment && entry.type === "tree"
    );
    if (next?.sha === undefined) {
      throw level.truncated ? TRUNCATED(scope) : SCOPE_MISSING(scope);
    }
    tree = next.sha;
  }
  const listing = await listTree(resolved, tree, true, context);
  if (listing.truncated) {
    throw TRUNCATED(scope);
  }
  return listing.tree;
}

interface Selected {
  path: string;
  sha: string;
  size: number;
}

interface Selection {
  omissions: RepositoryAcquisitionOmissions;
  selected: Selected[];
}

const SHOWN_PROBLEMS = 5;

/** The first few problems, and how many more there are. */
function listed(problems: readonly string[]): string {
  const shown = problems.slice(0, SHOWN_PROBLEMS).join("; ");
  const more = problems.length - SHOWN_PROBLEMS;
  return more > 0 ? `${shown}; and ${more} more` : shown;
}

/** Records one listed entry as omitted, or selects it for download. */
function classify(
  entry: TreeEntry & { path: string; sha: string },
  limits: GitHubAcquisitionLimits,
  { omissions, selected }: Selection
): void {
  if (entry.type === "tree") {
    return;
  }
  if (entry.type === "commit" || entry.mode === GITLINK_MODE) {
    omissions.submodules.push(entry.path);
  } else if (entry.mode === SYMLINK_MODE) {
    omissions.symlinks.push(entry.path);
  } else if (entry.path.split("/").includes("node_modules")) {
    omissions.nodeModules.push(entry.path);
  } else if (!isAnalysisInput(entry.path)) {
    omissions.notAnalysisInput += 1;
  } else if (entry.size === undefined) {
    throw new RepositoryAcquisitionError(
      "malformed-response",
      `GitHub's listing gives no size for ${JSON.stringify(entry.path)}.`
    );
  } else if (entry.size > limits.maxFileBytes) {
    omissions.tooLarge.push({ path: entry.path, size: entry.size });
  } else {
    selected.push({ path: entry.path, sha: entry.sha, size: entry.size });
  }
}

/** Classifies every entry before any download, refusing unsafe or colliding paths. */
function select(
  entries: readonly TreeEntry[],
  limits: GitHubAcquisitionLimits
): Selection {
  const selection: Selection = {
    omissions: {
      binary: [],
      nodeModules: [],
      notAnalysisInput: 0,
      notUtf8: [],
      submodules: [],
      symlinks: [],
      tooLarge: [],
    },
    selected: [],
  };
  const seen = new Set<string>();
  const unsafe: string[] = [];
  for (const entry of entries) {
    const { path, sha } = entry;
    if (
      typeof path !== "string" ||
      typeof sha !== "string" ||
      !GIT_SHA.test(sha)
    ) {
      throw malformed("the file listing");
    }
    if (seen.has(path)) {
      throw new RepositoryAcquisitionError(
        "malformed-response",
        `GitHub's listing names ${JSON.stringify(path)} twice.`
      );
    }
    seen.add(path);
    unsafe.push(...pathProblems(path));
    classify({ ...entry, path, sha }, limits, selection);
  }
  if (unsafe.length > 0) {
    throw new RepositoryAcquisitionError(
      "unsafe-path",
      `The listing has paths that cannot be placed safely: ${listed(unsafe)}.`
    );
  }
  const { selected } = selection;
  const collisions = collisionProblems(new Set(selected.map((f) => f.path)));
  if (collisions.length > 0) {
    throw new RepositoryAcquisitionError(
      "collision",
      `The listing has paths that collide in a file map: ${listed(collisions)}.`
    );
  }
  if (selected.length > limits.maxFiles) {
    throw new RepositoryAcquisitionError(
      "limit-exceeded",
      `The revision has ${selected.length} analysis inputs, over the provisional ${limits.maxFiles}-file limit. Choose a smaller scope.`
    );
  }
  const total = selected.reduce((sum, file) => sum + file.size, 0);
  if (total > limits.maxTotalBytes) {
    throw new RepositoryAcquisitionError(
      "limit-exceeded",
      `The revision's analysis inputs total ${total} bytes, over the provisional ${limits.maxTotalBytes}-byte limit. Choose a smaller scope.`
    );
  }
  return selection;
}

/** Git's object ID for blob `bytes`: SHA-1 over `blob {length}\0` and the bytes. */
export function gitBlobSha(bytes: Uint8Array): string {
  return bytesToHex(
    sha1
      .create()
      .update(utf8ToBytes(`blob ${bytes.byteLength}\0`))
      .update(bytes)
      .digest()
  );
}

/** The body, read only up to `max` bytes; `undefined` when it is longer. */
async function boundedBody(
  response: Response,
  max: number
): Promise<Uint8Array | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return new Uint8Array();
  }
  const bytes = new Uint8Array(max);
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return bytes.subarray(0, length);
    }
    if (length + value.byteLength > max) {
      await reader.cancel().catch(() => undefined);
      return;
    }
    bytes.set(value, length);
    length += value.byteLength;
  }
}

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type Downloaded =
  | { kind: "text"; text: string }
  | { kind: "binary" }
  | { kind: "not-utf8" };

const encodedPath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");

/** One file from the raw host at the resolved commit, checked against the listing. */
async function download(
  resolved: Resolved,
  scope: string | null,
  file: Selected,
  context: Context
): Promise<Downloaded> {
  const path = scope === null ? file.path : `${scope}/${file.path}`;
  const what = `${JSON.stringify(path)} at ${resolved.sha}`;
  let response: Response;
  try {
    response = await context.fetch(
      `${RAW}/${resolved.owner}/${resolved.repo}/${resolved.sha}/${encodedPath(path)}`,
      {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        ...(context.signal !== undefined && { signal: context.signal }),
      }
    );
  } catch (error) {
    context.signal?.throwIfAborted();
    throw networkFailure("raw.githubusercontent.com", what, error);
  }
  if (response.url !== "" && new URL(response.url).origin !== RAW) {
    await response.body?.cancel().catch(() => undefined);
    throw new RepositoryAcquisitionError(
      "unexpected-origin",
      `${what} was redirected away from raw.githubusercontent.com; it was not read.`
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const { status } = response;
    throw (
      rateLimited(
        status,
        (name) => response.headers.get(name),
        "raw.githubusercontent.com"
      ) ??
      new RepositoryAcquisitionError(
        status === 404 ? "missing-file" : "http-error",
        status === 404
          ? `${what} is listed but could not be downloaded (404); the revision cannot be loaded completely.`
          : `raw.githubusercontent.com answered ${status} for ${what}.`,
        { status }
      )
    );
  }
  const bytes = await boundedBody(response, file.size);
  context.signal?.throwIfAborted();
  if (
    bytes === undefined ||
    bytes.byteLength !== file.size ||
    gitBlobSha(bytes) !== file.sha
  ) {
    throw new RepositoryAcquisitionError(
      "integrity",
      `${what} does not match GitHub's listing (length or Git blob SHA-1).`
    );
  }
  if (bytes.includes(0)) {
    return { kind: "binary" };
  }
  try {
    return { kind: "text", text: fatalUtf8.decode(bytes) };
  } catch {
    return { kind: "not-utf8" };
  }
}

/**
 * Downloads `selected` with at most `concurrency` requests in flight. The
 * first failure aborts the others; the caller's abort wins over any failure.
 */
async function downloadAll(
  resolved: Resolved,
  scope: string | null,
  selected: readonly Selected[],
  context: Context,
  onProgress: GitHubLoadOptions["onProgress"]
): Promise<Downloaded[]> {
  const results: Downloaded[] = new Array(selected.length);
  const stop = new AbortController();
  const signal =
    context.signal === undefined
      ? stop.signal
      : AbortSignal.any([context.signal, stop.signal]);
  const inner: Context = { ...context, signal };
  const bytes = selected.reduce((sum, file) => sum + file.size, 0);
  let next = 0;
  let done = 0;
  const runner = async (): Promise<void> => {
    while (next < selected.length) {
      const index = next;
      next += 1;
      signal.throwIfAborted();
      try {
        results[index] = await download(
          resolved,
          scope,
          selected[index] as Selected,
          inner
        );
      } catch (error) {
        stop.abort(error);
        throw error;
      }
      done += 1;
      onProgress?.({
        bytes,
        done,
        files: selected.length,
        phase: "download",
        stage: "progress",
      });
    }
  };
  const settled = await Promise.allSettled(
    Array.from(
      { length: Math.min(context.limits.concurrency, selected.length) },
      runner
    )
  );
  context.signal?.throwIfAborted();
  if (settled.some((result) => result.status === "rejected")) {
    throw stop.signal.reason;
  }
  return results;
}

function limitsOf(
  overrides: Partial<GitHubAcquisitionLimits> | undefined
): GitHubAcquisitionLimits {
  const limits = { ...PROVISIONAL_GITHUB_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!(Number.isSafeInteger(value) && value > 0)) {
      throw new RangeError(`The ${name} limit must be a positive integer.`);
    }
  }
  return limits;
}

/**
 * Loads `request`'s revision as a file map, or rejects with
 * `RepositoryAcquisitionError` (or the signal's reason once it aborts).
 */
export async function loadGitHubRepository(
  request: GitHubRepositoryRequest,
  options: GitHubLoadOptions = {}
): Promise<LoadedGitHubRepository> {
  const { onProgress, signal } = options;
  const limits = limitsOf(options.limits);
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const context: Context = {
    fetch,
    limits,
    request: octokitRequest.defaults({
      baseUrl: API,
      request: { fetch, ...(signal !== undefined && { signal }) },
    }),
    signal,
  };
  signal?.throwIfAborted();

  let at = performance.now();
  onProgress?.({ phase: "resolve", stage: "start" });
  const resolved = await resolveRevision(request, context);
  onProgress?.({ phase: "resolve", stage: "end" });
  const resolveMs = performance.now() - at;

  at = performance.now();
  onProgress?.({ phase: "list", stage: "start" });
  const entries = await scopedEntries(resolved, request.scope, context);
  const { omissions, selected } = select(entries, limits);
  onProgress?.({ entries: entries.length, phase: "list", stage: "end" });
  const listMs = performance.now() - at;

  at = performance.now();
  const bytes = selected.reduce((sum, file) => sum + file.size, 0);
  const files = selected.length;
  onProgress?.({ bytes, done: 0, files, phase: "download", stage: "start" });
  const downloads = await downloadAll(
    resolved,
    request.scope,
    selected,
    context,
    onProgress
  );
  const map: Record<string, string> = {};
  let readBytes = 0;
  for (const [index, file] of selected.entries()) {
    const result = downloads[index];
    if (result?.kind === "text") {
      map[file.path] = result.text;
      readBytes += file.size;
    } else if (result?.kind === "binary") {
      omissions.binary.push(file.path);
    } else {
      omissions.notUtf8.push(file.path);
    }
  }
  onProgress?.({ bytes, done: files, files, phase: "download", stage: "end" });
  const downloadMs = performance.now() - at;

  const limitations: RepositoryAcquisitionLimitation[] = [
    "history-not-fetched",
    "integrity-is-listing-consistency",
    "dependencies-not-installed",
    "public-repositories-only",
    ...(request.scope === null ? [] : (["outside-scope-not-read"] as const)),
    ...(request.ref === null || GIT_SHA.test(request.ref)
      ? []
      : (["named-ref-resolved-by-github"] as const)),
  ];
  return {
    acquisition: {
      integrity: "git-blob-sha1-matches-listing",
      limitations,
      limits: {
        concurrency: limits.concurrency,
        maxFileBytes: limits.maxFileBytes,
        maxFiles: limits.maxFiles,
        maxTotalBytes: limits.maxTotalBytes,
        maxTreeEntries: limits.maxTreeEntries,
      },
      omissions,
      origins: [API, RAW],
      read: { bytes: readBytes, files: Object.keys(map).length },
    },
    files: map,
    repository: {
      defaultBranch: resolved.defaultBranch,
      host: "github.com",
      owner: resolved.owner,
      refKind: refKindOf(request.ref),
      repo: resolved.repo,
      requestedRef: request.ref,
      resolvedCommit: resolved.sha,
      scope: request.scope,
    },
    root: githubRepositoryRoot(resolved.owner, resolved.repo, request.scope),
    timing: { downloadMs, listMs, resolveMs },
  };
}
