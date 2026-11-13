import { GIT_SHA, GITHUB_OWNER, GITHUB_REPO } from "./dataset-analysis";

// INTERNAL: what a person asks to scan, normalized to public GitHub
// coordinates before any request is made. Only `https://github.com/...`
// URLs are accepted; a URL with credentials, a port, a query or a fragment
// is refused, and no refusal ever repeats the URL, so a pasted token never
// reaches a message or a log. A `tree/` URL is split into ref and scope only
// when that is unambiguous (one segment, or a full commit SHA first); any
// other split is refused with the explicit `ref` and `scope` fields as the
// way out, because a branch named `feature/x` and a directory `x` look the
// same. Nothing here touches the network.

/** What a caller supplies: a repository URL, and optionally the ref and scope separately. */
export interface GitHubRepositoryInput {
  /** A branch, tag or commit SHA. Overrides nothing: a URL's own ref must agree. */
  readonly ref?: string;
  /** A repository-relative directory to analyse as the root. */
  readonly scope?: string;
  readonly url: string;
}

/** Normalized coordinates of one request; nothing resolved yet. */
export interface GitHubRepositoryRequest {
  readonly owner: string;
  /** Null asks for the default branch. */
  readonly ref: string | null;
  readonly repo: string;
  /** A normalized repository-relative directory, or null for the root. */
  readonly scope: string | null;
}

/** An input this loader does not accept, with every reason found. */
export class RepositoryInputError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Unsupported repository input:\n- ${problems.join("\n- ")}`);
    this.name = "RepositoryInputError";
    this.problems = problems;
  }
}

/** The github.com path segments after a repository that this loader understands. */
const TREE = "tree";
const COMMIT = "commit";
const GIT_SUFFIX = /\.git$/;
// Git's check-ref-format rules a browser can apply without Git.
const REF_FORBIDDEN =
  /[\s~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|^-|\.$|\.lock(\/|$)|(^|\/)\./;
const TRAILING_SLASHES = /\/+$/;
const MAX_CONTROL = 0x1f;
const DELETE = 0x7f;
const MAX_REF_LENGTH = 255;
const MAX_SCOPE_LENGTH = 1024;

/** Whether `text` has an ASCII control character, which Git refuses in refs. */
function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= MAX_CONTROL || code === DELETE) {
      return true;
    }
  }
  return false;
}

function refProblems(ref: string, label: string): string[] {
  if (
    ref === "" ||
    ref.length > MAX_REF_LENGTH ||
    REF_FORBIDDEN.test(ref) ||
    hasControl(ref)
  ) {
    return [`${label} is not a valid Git branch, tag or commit name`];
  }
  return [];
}

/** A normalized repository-relative directory, or the problems with it. */
function scopeOf(scope: string, label: string): string | string[] {
  const trimmed = scope.replace(TRAILING_SLASHES, "");
  if (
    trimmed === "" ||
    trimmed.length > MAX_SCOPE_LENGTH ||
    trimmed.startsWith("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed
      .split("/")
      .some((s) => s === "" || s === "." || s === ".." || s === ".git")
  ) {
    return [
      `${label} must be a repository-relative directory without empty, ".", ".." or ".git" segments`,
    ];
  }
  return trimmed;
}

/** Decodes one path segment, or null when it is not valid percent-encoding. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

interface UrlParts {
  owner: string;
  repo: string;
  /** Segments after the repository, decoded. */
  rest: string[];
}

function urlParts(text: string): UrlParts | string[] {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return [
      "the repository must be an https://github.com/{owner}/{repository} URL",
    ];
  }
  const problems: string[] = [];
  if (url.protocol !== "https:") {
    problems.push("only https:// URLs are accepted");
  }
  if (url.hostname !== "github.com") {
    problems.push(
      "only public repositories on github.com are supported; other hosts are not"
    );
  }
  if (url.username !== "" || url.password !== "") {
    problems.push(
      "the URL carries credentials; remove them (private access is not supported)"
    );
  }
  if (url.port !== "") {
    problems.push("the URL names a port; use https://github.com/...");
  }
  if (url.search !== "" || url.hash !== "") {
    problems.push(
      "the URL has a query or fragment; give the ref and scope as separate fields"
    );
  }
  if (problems.length > 0) {
    return problems;
  }
  const raw = url.pathname.replace(TRAILING_SLASHES, "").split("/").slice(1);
  const segments = raw.map(decodeSegment);
  if (segments.some((s) => s === null || s === "")) {
    return ["the URL path has an empty or invalid segment"];
  }
  const [owner = "", repoSegment = "", ...rest] = segments as string[];
  const repo = repoSegment.replace(GIT_SUFFIX, "");
  if (!GITHUB_OWNER.test(owner)) {
    problems.push("the owner is not a valid GitHub user or organization name");
  }
  if (!GITHUB_REPO.test(repo)) {
    problems.push("the repository name is not a valid GitHub repository name");
  }
  if (repo !== repoSegment && rest.length > 0) {
    problems.push("a .git suffix is accepted only on a repository root URL");
  }
  return problems.length > 0 ? problems : { owner, repo, rest };
}

interface Located {
  ref: string | null;
  scope: string | null;
}

/**
 * The ref and scope a URL's remaining segments name, reconciled with the
 * explicit fields. Never guesses where a ref containing `/` ends.
 */
function locate(
  rest: string[],
  input: GitHubRepositoryInput
): Located | string[] {
  const explicitRef = input.ref;
  if (rest.length === 0) {
    return { ref: explicitRef ?? null, scope: null };
  }
  const [kind, ...tail] = rest;
  if (kind === COMMIT && tail.length === 1 && tail[0] !== undefined) {
    const sha = tail[0].toLowerCase();
    if (!GIT_SHA.test(sha)) {
      return ["a /commit/ URL must name a full 40-character commit SHA"];
    }
    if (explicitRef !== undefined && explicitRef.toLowerCase() !== sha) {
      return ["the ref field disagrees with the commit in the URL"];
    }
    return { ref: sha, scope: null };
  }
  if (kind !== TREE || tail.length === 0) {
    return [
      "only repository root, /tree/{ref}[/{directory}] and /commit/{sha} URLs are supported",
    ];
  }
  const joined = tail.join("/");
  if (explicitRef !== undefined) {
    // The caller says where the ref ends; the rest is the scope.
    if (joined === explicitRef) {
      return { ref: explicitRef, scope: null };
    }
    if (joined.startsWith(`${explicitRef}/`)) {
      return { ref: explicitRef, scope: joined.slice(explicitRef.length + 1) };
    }
    return ["the ref field does not match the start of the /tree/ path"];
  }
  const [first = ""] = tail;
  if (tail.length === 1) {
    return { ref: first, scope: null };
  }
  if (GIT_SHA.test(first.toLowerCase())) {
    return { ref: first.toLowerCase(), scope: tail.slice(1).join("/") };
  }
  return [
    `the /tree/ path is ambiguous: its ${tail.length} segments could be a branch name containing "/" or a branch followed by a directory; give the ref (and scope) as separate fields`,
  ];
}

/**
 * Normalizes `input` into owner, repository, ref and scope, or throws
 * `RepositoryInputError` listing every reason it is not supported.
 */
export function parseGitHubRepositoryInput(
  input: GitHubRepositoryInput
): GitHubRepositoryRequest {
  if (typeof input.url !== "string") {
    throw new RepositoryInputError(["the repository URL must be text"]);
  }
  const parts = urlParts(input.url);
  if (Array.isArray(parts)) {
    throw new RepositoryInputError(parts);
  }
  const problems: string[] = [];
  if (input.ref !== undefined) {
    problems.push(...refProblems(input.ref, "the ref field"));
  }
  if (problems.length > 0) {
    throw new RepositoryInputError(problems);
  }
  const located = locate(parts.rest, input);
  if (Array.isArray(located)) {
    throw new RepositoryInputError(located);
  }
  if (located.ref !== null) {
    problems.push(...refProblems(located.ref, "the ref"));
  }
  if (
    input.scope !== undefined &&
    located.scope !== null &&
    located.scope !== input.scope.replace(TRAILING_SLASHES, "")
  ) {
    problems.push("the scope field disagrees with the directory in the URL");
  }
  const scope = input.scope ?? located.scope;
  let normalizedScope: string | null = null;
  if (scope !== null) {
    const checked = scopeOf(scope, "the scope");
    if (Array.isArray(checked)) {
      problems.push(...checked);
    } else {
      normalizedScope = checked;
    }
  }
  if (problems.length > 0) {
    throw new RepositoryInputError(problems);
  }
  return {
    owner: parts.owner,
    ref: located.ref,
    repo: parts.repo,
    scope: normalizedScope,
  };
}
