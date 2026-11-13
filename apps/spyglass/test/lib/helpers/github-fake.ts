import { gitBlobSha } from "../../../src/lib/github-loader";

// A deterministic stand-in for GitHub's REST API and raw content host, as
// a `fetch`: repositories, refs and commits held in memory, tree listings
// with real Git blob SHA-1s, and hooks to replace or hold any response.
// Every request is recorded with its init, so tests can assert exactly
// which URLs were contacted, with what headers and credentials mode. Like a
// real fetch, it rejects with the signal's reason when its request aborts.

export type FakeEntry =
  | string
  | Uint8Array
  | { kind: "symlink"; target: string }
  | { kind: "submodule"; sha: string };

export interface FakeRepository {
  commits: Record<string, Record<string, FakeEntry>>;
  defaultBranch: string;
  /** The canonical `owner/repo` the API returns; default: the key it is stored under. */
  fullName?: string;
  private?: boolean;
  /** Branch and tag names to commit SHAs; mutable, so a branch can move mid-load. */
  refs: Record<string, string>;
}

interface FakeRequest {
  init: RequestInit | undefined;
  url: string;
}

/** Returns a response to use instead of the fake's own, or undefined to let it answer. */
export type FakeHook = (
  url: URL,
  request: FakeRequest
) => Promise<Response | undefined> | Response | undefined;

const encoder = new TextEncoder();
const bytesOf = (entry: string | Uint8Array) =>
  typeof entry === "string" ? encoder.encode(entry) : entry;

/** A deterministic 40-hex id for a test-only object (a tree or a submodule commit). */
export function fakeSha(seed: string): string {
  return gitBlobSha(encoder.encode(`fake:${seed}`));
}

interface Listed {
  mode: string;
  path: string;
  sha: string;
  size?: number;
  type: "blob" | "commit" | "tree";
}

function listing(files: Record<string, FakeEntry>, commit: string): Listed[] {
  const entries = new Map<string, Listed>();
  for (const [path, entry] of Object.entries(files)) {
    const segments = path.split("/");
    for (let end = 1; end < segments.length; end += 1) {
      const dir = segments.slice(0, end).join("/");
      entries.set(dir, {
        mode: "040000",
        path: dir,
        sha: fakeSha(`${commit}:${dir}`),
        type: "tree",
      });
    }
    if (typeof entry === "string" || entry instanceof Uint8Array) {
      const bytes = bytesOf(entry);
      entries.set(path, {
        mode: "100644",
        path,
        sha: gitBlobSha(bytes),
        size: bytes.byteLength,
        type: "blob",
      });
    } else if (entry.kind === "symlink") {
      const bytes = encoder.encode(entry.target);
      entries.set(path, {
        mode: "120000",
        path,
        sha: gitBlobSha(bytes),
        size: bytes.byteLength,
        type: "blob",
      });
    } else {
      entries.set(path, {
        mode: "160000",
        path,
        sha: entry.sha,
        type: "commit",
      });
    }
  }
  return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status,
  });

export function fakeGitHub(stored: Record<string, FakeRepository>) {
  // GitHub matches owner and repository names without regard to case.
  const repositories = new Map(
    Object.entries(stored).map(([name, repo]) => [name.toLowerCase(), repo])
  );
  const find = (owner = "", repo = "") =>
    repositories.get(`${owner}/${repo}`.toLowerCase());
  const requests: FakeRequest[] = [];
  const hooks: FakeHook[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  /** The tree a commit or tree id names: [commit, directory prefix]. */
  interface FoundTree {
    files: Record<string, FakeEntry>;
    listed: Listed[];
    prefix: string;
  }

  const treeOf = (repository: FakeRepository, id: string): FoundTree | null => {
    for (const [commit, files] of Object.entries(repository.commits)) {
      if (commit === id) {
        return { files, listed: listing(files, commit), prefix: "" };
      }
      const listed = listing(files, commit);
      const dir = listed.find(
        (entry) => entry.type === "tree" && entry.sha === id
      );
      if (dir !== undefined) {
        return { files, listed, prefix: `${dir.path}/` };
      }
    }
    return null;
  };

  const commitAnswer = (repository: FakeRepository, ref: string): Response => {
    const sha =
      repository.refs[ref] ?? (ref in repository.commits ? ref : undefined);
    return sha === undefined
      ? json({ message: `No commit found for SHA: ${ref}` }, 422)
      : new Response(sha, {
          headers: {
            "content-type": "application/vnd.github.sha; charset=utf-8",
          },
        });
  };

  const treeAnswer = (
    repository: FakeRepository,
    id: string,
    recursive: boolean
  ): Response => {
    const tree = treeOf(repository, id);
    if (tree === null) {
      return json({ message: "Not Found" }, 404);
    }
    const below = tree.listed
      .filter((entry) => entry.path.startsWith(tree.prefix))
      .map((entry) => ({
        ...entry,
        path: entry.path.slice(tree.prefix.length),
      }))
      .filter((entry) => recursive || !entry.path.includes("/"));
    return json({ sha: id, tree: below, truncated: false });
  };

  const apiAnswer = (url: URL, parts: string[]): Response => {
    const [, owner, repo, kind, ...rest] = parts;
    const repository = find(owner, repo);
    if (repository === undefined) {
      return json({ message: "Not Found" }, 404);
    }
    if (kind === undefined) {
      return json({
        default_branch: repository.defaultBranch,
        full_name: repository.fullName ?? `${owner}/${repo}`,
        private: repository.private ?? false,
      });
    }
    if (kind === "commits") {
      return commitAnswer(repository, rest.join("/"));
    }
    const [git, id] = rest;
    if (kind === "git" && git === "trees" && id !== undefined) {
      return treeAnswer(
        repository,
        id,
        url.searchParams.get("recursive") === "1"
      );
    }
    return new Response("unexpected", { status: 500 });
  };

  const rawAnswer = (parts: string[]): Response => {
    const [owner, repo, commit = "", ...path] = parts;
    const entry = find(owner, repo)?.commits[commit]?.[path.join("/")];
    if (typeof entry === "string" || entry instanceof Uint8Array) {
      return new Response(bytesOf(entry) as Uint8Array<ArrayBuffer>);
    }
    return new Response("404: Not Found", { status: 404 });
  };

  const answer = (url: URL): Response => {
    const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
    if (url.host === "api.github.com" && parts[0] === "repos") {
      return apiAnswer(url, parts);
    }
    if (url.host === "raw.githubusercontent.com") {
      return rawAnswer(parts);
    }
    return new Response("unexpected", { status: 500 });
  };

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const request = { init, url: url.href };
    requests.push(request);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // As a real fetch: an abort rejects with the signal's reason at once,
    // whatever a held hook does later.
    const signal = init?.signal ?? undefined;
    const respond = async () => {
      for (const hook of hooks) {
        const replaced = await hook(url, request);
        if (replaced !== undefined) {
          return replaced;
        }
      }
      // A response always reads as a fresh one from the network.
      return answer(url);
    };
    try {
      signal?.throwIfAborted();
      if (signal === undefined) {
        return await respond();
      }
      return await new Promise<Response>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        respond().then(resolve, reject);
      });
    } finally {
      inFlight -= 1;
    }
  }) as typeof globalThis.fetch;

  return {
    fetch,
    hook(next: FakeHook) {
      hooks.push(next);
    },
    get maxInFlight() {
      return maxInFlight;
    },
    requests,
    /** Request URLs, in order. */
    urls: () => requests.map((request) => request.url),
  };
}

/** A promise with its resolver exposed, for holding a response. */
export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
