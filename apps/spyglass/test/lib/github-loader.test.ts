import { describe, expect, it } from "vitest";
import type { GitHubLoadOptions } from "../../src/lib/github-loader";
import {
  gitBlobSha,
  isAnalysisInput,
  loadGitHubRepository,
  PROVISIONAL_GITHUB_LIMITS,
  RepositoryAcquisitionError,
} from "../../src/lib/github-loader";
import type { GitHubRepositoryRequest } from "../../src/lib/github-request";
import type { FakeRepository } from "./helpers/github-fake";
import { deferred, fakeGitHub, fakeSha } from "./helpers/github-fake";

// The public GitHub loader against a deterministic fake of GitHub's REST
// API and raw host: exact requests and their credentials mode, commit
// pinning, scope and truncation handling, explicit omissions, every
// refusal before allocation where the listing allows it, integrity against
// the listing, rate limits, and abort through every await.

const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";
const SECRET = "export const apiKey = 'SOURCE-SECRET-123';\n";

const FILES = {
  ".gitignore": "dist\n",
  "docs/logo.png": new Uint8Array([137, 80, 78, 71]),
  "node_modules/left-pad/index.js": "module.exports = 1;\n",
  "package.json": JSON.stringify({ name: "demo", workspaces: ["packages/*"] }),
  "packages/a/package.json": JSON.stringify({ name: "@demo/a" }),
  "packages/a/src/bin.ts": new Uint8Array([0x61, 0x00, 0x62]),
  "packages/a/src/index.ts": SECRET,
  "packages/a/src/link.ts": {
    kind: "symlink" as const,
    target: "../../../etc/passwd",
  },
  "packages/a/src/weird.ts": new Uint8Array([0xff, 0xfe, 0x41]),
  "packages/b/package.json": JSON.stringify({ name: "@demo/b" }),
  "packages/b/src/index.ts": 'import { a } from "@demo/a";\n',
  "README.md": "# not an analysis input\n",
  "vendor/lib": { kind: "submodule" as const, sha: fakeSha("vendor") },
};

const repository = (): FakeRepository => ({
  commits: {
    [NEW]: { "package.json": JSON.stringify({ name: "moved" }) },
    [OLD]: FILES,
  },
  defaultBranch: "main",
  refs: { main: OLD, "v1.0": OLD },
});

const request = (
  fields: Partial<GitHubRepositoryRequest> = {}
): GitHubRepositoryRequest => ({
  owner: "octo",
  ref: null,
  repo: "demo",
  scope: null,
  ...fields,
});

const setup = (repo: FakeRepository = repository()) => {
  const github = fakeGitHub({ "octo/demo": repo });
  const load = (
    fields: Partial<GitHubRepositoryRequest> = {},
    options: GitHubLoadOptions = {}
  ) =>
    loadGitHubRepository(request(fields), { fetch: github.fetch, ...options });
  return { github, load, repo };
};

async function failure(
  promise: Promise<unknown>
): Promise<RepositoryAcquisitionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RepositoryAcquisitionError) {
      return error;
    }
    throw error;
  }
  throw new Error("loaded");
}

const rawUrls = (urls: string[]) =>
  urls.filter((url) => url.startsWith("https://raw.githubusercontent.com/"));

describe("loadGitHubRepository: resolution and listing", () => {
  it("resolves the default branch to a commit and fetches only by that commit", async () => {
    const { github, load } = setup();
    const loaded = await load();
    const urls = github.urls();
    expect(urls.slice(0, 3)).toEqual([
      "https://api.github.com/repos/octo/demo",
      "https://api.github.com/repos/octo/demo/commits/main",
      `https://api.github.com/repos/octo/demo/git/trees/${OLD}?recursive=1`,
    ]);
    const raw = rawUrls(urls);
    expect(raw).toHaveLength(urls.length - 3);
    expect(raw.every((url) => url.includes(`/octo/demo/${OLD}/`))).toBe(true);
    expect(loaded.repository).toEqual({
      defaultBranch: "main",
      host: "github.com",
      owner: "octo",
      refKind: "default-branch",
      repo: "demo",
      requestedRef: null,
      resolvedCommit: OLD,
      scope: null,
    });
    expect(loaded.root).toBe("/github/octo/demo");
    expect(Object.keys(loaded.files).sort()).toEqual([
      ".gitignore",
      "package.json",
      "packages/a/package.json",
      "packages/a/src/index.ts",
      "packages/b/package.json",
      "packages/b/src/index.ts",
    ]);
    expect(loaded.acquisition.limitations).toEqual([
      "history-not-fetched",
      "integrity-is-listing-consistency",
      "dependencies-not-installed",
      "public-repositories-only",
    ]);
    expect(loaded.acquisition.origins).toEqual([
      "https://api.github.com",
      "https://raw.githubusercontent.com",
    ]);
  });

  it("asks the API for the bare SHA and downloads raw files without credentials", async () => {
    const { github, load } = setup();
    await load();
    const headers = github.requests[1]?.init?.headers as Record<string, string>;
    expect(headers.accept).toBe("application/vnd.github.v3.sha");
    for (const { init, url } of github.requests) {
      // API calls are Octokit's: no cookie-bearing mode, no authorization.
      expect(init?.credentials ?? "same-origin").not.toBe("include");
      expect(Object.keys(init?.headers ?? {})).not.toContain("authorization");
      if (url.startsWith("https://raw.githubusercontent.com/")) {
        expect(init?.credentials).toBe("omit");
        expect(init?.headers).toBeUndefined();
      }
    }
  });

  it("records explicit omissions and never downloads what it omits", async () => {
    const { github, load } = setup();
    const loaded = await load();
    expect(loaded.acquisition.omissions).toEqual({
      binary: ["packages/a/src/bin.ts"],
      nodeModules: ["node_modules/left-pad/index.js"],
      notAnalysisInput: 2,
      notUtf8: ["packages/a/src/weird.ts"],
      submodules: ["vendor/lib"],
      symlinks: ["packages/a/src/link.ts"],
      tooLarge: [],
    });
    const raw = rawUrls(github.urls()).join("\n");
    for (const never of [
      "link.ts",
      "vendor",
      "node_modules",
      "README.md",
      "logo.png",
    ]) {
      expect(raw).not.toContain(never);
    }
    expect(loaded.acquisition.read).toEqual({
      bytes: Object.values(loaded.files).reduce(
        (sum, text) => sum + new TextEncoder().encode(text).byteLength,
        0
      ),
      files: 6,
    });
  });

  it("takes a named ref through GitHub and states that GitHub chose its kind", async () => {
    const { github, load } = setup();
    const loaded = await load({ ref: "v1.0" });
    expect(github.urls()[1]).toBe(
      "https://api.github.com/repos/octo/demo/commits/v1.0"
    );
    expect(loaded.repository).toMatchObject({
      refKind: "named",
      requestedRef: "v1.0",
      resolvedCommit: OLD,
    });
    expect(loaded.acquisition.limitations).toContain(
      "named-ref-resolved-by-github"
    );
  });

  it("fetches a pinned commit even when its branch moves during the load", async () => {
    const { github, load, repo } = setup();
    github.hook((url) => {
      if (url.host === "raw.githubusercontent.com") {
        repo.refs.main = NEW;
      }
    });
    const loaded = await load({ ref: OLD });
    expect(repo.refs.main).toBe(NEW);
    expect(loaded.repository).toMatchObject({
      refKind: "commit-sha",
      resolvedCommit: OLD,
    });
    expect(loaded.files["package.json"]).toBe(FILES["package.json"]);
    expect(rawUrls(github.urls()).every((url) => url.includes(OLD))).toBe(true);
  });

  it("uses the canonical owner and repository names GitHub returns", async () => {
    const { load } = setup({ ...repository(), fullName: "Octo/Demo" });
    const loaded = await load();
    expect(loaded.repository).toMatchObject({ owner: "Octo", repo: "Demo" });
    expect(loaded.root).toBe("/github/Octo/Demo");
  });

  it("refuses a resolved commit other than the full SHA requested", async () => {
    const { github, load } = setup();
    github.hook((url) =>
      url.pathname.includes("/commits/") ? new Response(NEW) : undefined
    );
    const error = await failure(load({ ref: OLD }));
    expect(error.code).toBe("malformed-response");
  });

  it("loads a scope as the root, with scope-relative paths", async () => {
    const { load } = setup();
    const loaded = await load({ scope: "packages/b" });
    expect(loaded.root).toBe("/github/octo/demo/packages/b");
    expect(loaded.files).toEqual({
      "package.json": FILES["packages/b/package.json"],
      "src/index.ts": FILES["packages/b/src/index.ts"],
    });
    expect(loaded.repository.scope).toBe("packages/b");
    expect(loaded.acquisition.limitations).toContain("outside-scope-not-read");
  });

  it.each(["packages/missing", "package.json"])(
    "refuses a scope that is not a directory: %s",
    async (scope) => {
      const { github, load } = setup();
      const error = await failure(load({ scope }));
      expect(error.code).toBe("scope-not-found");
      expect(rawUrls(github.urls())).toEqual([]);
    }
  );
});

describe("loadGitHubRepository: truncated listings", () => {
  const truncateRecursiveRoot = (github: ReturnType<typeof fakeGitHub>) =>
    github.hook((url) =>
      url.pathname.endsWith(`/git/trees/${OLD}`) &&
      url.searchParams.get("recursive") === "1"
        ? Response.json({ sha: OLD, tree: [], truncated: true })
        : undefined
    );

  it("fails on a truncated listing without a scope, downloading nothing", async () => {
    const { github, load } = setup();
    truncateRecursiveRoot(github);
    const error = await failure(load());
    expect(error.code).toBe("truncated-listing");
    expect(error.message).toContain("Choose a smaller scope");
    expect(rawUrls(github.urls())).toEqual([]);
  });

  it("walks down to a scope's own tree when the root listing is truncated", async () => {
    const { github, load } = setup();
    truncateRecursiveRoot(github);
    const loaded = await load({ scope: "packages/b" });
    const trees = github.urls().filter((url) => url.includes("/git/trees/"));
    expect(trees).toEqual([
      `https://api.github.com/repos/octo/demo/git/trees/${OLD}?recursive=1`,
      `https://api.github.com/repos/octo/demo/git/trees/${OLD}`,
      `https://api.github.com/repos/octo/demo/git/trees/${fakeSha(`${OLD}:packages`)}`,
      `https://api.github.com/repos/octo/demo/git/trees/${fakeSha(`${OLD}:packages/b`)}?recursive=1`,
    ]);
    expect(Object.keys(loaded.files)).toEqual(["package.json", "src/index.ts"]);
  });

  it("fails when the scope's own listing is truncated too", async () => {
    const { github, load } = setup();
    truncateRecursiveRoot(github);
    github.hook((url) =>
      url.pathname.endsWith(fakeSha(`${OLD}:packages/b`))
        ? Response.json({ sha: "x", tree: [], truncated: true })
        : undefined
    );
    const error = await failure(load({ scope: "packages/b" }));
    expect(error.code).toBe("truncated-listing");
    expect(rawUrls(github.urls())).toEqual([]);
  });

  it("bounds the walk by the scope depth limit", async () => {
    const { github, load } = setup();
    truncateRecursiveRoot(github);
    const error = await failure(
      load({ scope: "packages/b" }, { limits: { maxScopeDepth: 1 } })
    );
    expect(error.code).toBe("limit-exceeded");
    expect(github.urls()).toHaveLength(3);
  });
});

describe("loadGitHubRepository: refusals before download", () => {
  it("answers 404 as not found or private, naming only the coordinates", async () => {
    const { load } = setup();
    const error = await failure(
      loadGitHubRepository(request({ repo: "secret" }), {
        fetch: fakeGitHub({}).fetch,
      })
    );
    expect(error.code).toBe("not-found-or-private");
    expect(error.message).toBe(
      "github.com/octo/secret was not found. Without credentials GitHub answers the same for a private repository; only public repositories are supported."
    );
    expect(load).toBeDefined();
  });

  it("refuses a repository the API reports private", async () => {
    const { load } = setup({ ...repository(), private: true });
    expect((await failure(load())).code).toBe("private-repository");
  });

  it("reports a ref that names no commit", async () => {
    const { load } = setup();
    const error = await failure(load({ ref: "nope" }));
    expect(error.code).toBe("ref-not-found");
    expect(error.message).toBe(
      'No commit was found for ref "nope" of github.com/octo/demo.'
    );
  });

  it("reports the API rate limit with its reset time", async () => {
    const { github, load } = setup();
    github.hook(
      () =>
        new Response("{}", {
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1794203326",
          },
          status: 403,
        })
    );
    const error = await failure(load());
    expect(error.code).toBe("rate-limited");
    expect(error.resetAt?.toISOString()).toBe("2026-11-09T05:48:46.000Z");
    expect(error.message).toContain("it resets at 2026-11-09T05:48:46.000Z");
    expect(github.urls()).toHaveLength(1);
  });

  it("reports a secondary limit's Retry-After, without retrying", async () => {
    const { github, load } = setup();
    github.hook(
      () =>
        new Response("{}", { headers: { "retry-after": "60" }, status: 429 })
    );
    const error = await failure(load());
    expect(error).toMatchObject({ code: "rate-limited", status: 429 });
    expect(error.message).toContain("retry after 60 seconds");
    expect(github.urls()).toHaveLength(1);
  });

  it("treats a plain 403 as an HTTP error, not a rate limit", async () => {
    const { github, load } = setup();
    github.hook(() => new Response("{}", { status: 403 }));
    expect(await failure(load())).toMatchObject({
      code: "http-error",
      status: 403,
    });
  });

  it.each([
    ["repository JSON", "/repos/octo/demo", "{not json"],
    ["repository shape", "/repos/octo/demo", JSON.stringify({ private: "no" })],
    ["commit SHA", "/commits/main", "not-a-sha"],
    [
      "tree shape",
      "/git/trees/",
      JSON.stringify({ tree: [{ path: 1 }], truncated: false }),
    ],
    [
      "tree without blob size",
      "/git/trees/",
      JSON.stringify({
        tree: [{ mode: "100644", path: "a.ts", sha: OLD, type: "blob" }],
        truncated: false,
      }),
    ],
    [
      "duplicate tree path",
      "/git/trees/",
      JSON.stringify({
        tree: [
          { mode: "100644", path: "a.ts", sha: OLD, size: 1, type: "blob" },
          { mode: "100644", path: "a.ts", sha: OLD, size: 1, type: "blob" },
        ],
        truncated: false,
      }),
    ],
  ])("refuses a malformed %s", async (_label, path, body) => {
    const { github, load } = setup();
    github.hook((url) =>
      url.pathname.includes(path) ? new Response(body) : undefined
    );
    expect((await failure(load())).code).toBe("malformed-response");
    expect(rawUrls(github.urls())).toEqual([]);
  });

  it.each([
    [
      "file count",
      { maxFiles: 5 },
      "8 analysis inputs, over the provisional 5-file limit",
    ],
    [
      "total bytes",
      { maxTotalBytes: 50 },
      "over the provisional 50-byte limit",
    ],
    ["tree entries", { maxTreeEntries: 3 }, "over the 3-entry limit"],
  ])(
    "refuses a revision over the %s limit before any download",
    async (_label, limits, text) => {
      const { github, load } = setup();
      const error = await failure(load({}, { limits }));
      expect(error.code).toBe("limit-exceeded");
      expect(error.message).toContain(text);
      expect(rawUrls(github.urls())).toEqual([]);
    }
  );

  it("omits a file over the single-file limit and lists its size", async () => {
    const { github, load } = setup();
    const loaded = await load({}, { limits: { maxFileBytes: 40 } });
    expect(loaded.acquisition.omissions.tooLarge).toEqual([
      { path: "package.json", size: FILES["package.json"].length },
      { path: "packages/a/src/index.ts", size: SECRET.length },
    ]);
    expect(rawUrls(github.urls()).join("\n")).not.toContain("src/index.ts\n");
    expect(loaded.files["packages/a/src/index.ts"]).toBeUndefined();
  });

  it("refuses limits that are not positive integers", async () => {
    const { load } = setup();
    await expect(load({}, { limits: { concurrency: 0 } })).rejects.toThrow(
      "The concurrency limit must be a positive integer."
    );
  });

  it.each([
    [
      "a case-only collision",
      { "src/A.ts": "a", "src/a.ts": "b" },
      "collision",
    ],
    ["a traversal path", { "../escape.ts": "x" }, "unsafe-path"],
    ["a backslash path", { "src\\evil.ts": "x" }, "unsafe-path"],
  ])("refuses %s before any download", async (_label, files, code) => {
    const { github, load } = setup({
      commits: { [OLD]: { "package.json": "{}", ...files } },
      defaultBranch: "main",
      refs: { main: OLD },
    });
    expect((await failure(load())).code).toBe(code);
    expect(rawUrls(github.urls())).toEqual([]);
  });
});

describe("loadGitHubRepository: downloads", () => {
  it("fails on a listed file the raw host does not have", async () => {
    const { github, load } = setup();
    github.hook((url) =>
      url.pathname.endsWith("/packages/b/src/index.ts")
        ? new Response("404: Not Found", { status: 404 })
        : undefined
    );
    const error = await failure(load());
    expect(error.code).toBe("missing-file");
    expect(error.message).toContain('"packages/b/src/index.ts"');
  });

  it("refuses a body longer than the listing promises, while streaming", async () => {
    const { github, load } = setup();
    github.hook((url) =>
      url.pathname.endsWith("/packages/b/src/index.ts")
        ? new Response(`${FILES["packages/b/src/index.ts"]}extra`)
        : undefined
    );
    const error = await failure(load());
    expect(error.code).toBe("integrity");
    expect(error.message).toContain("does not match GitHub's listing");
  });

  it("refuses bytes whose Git blob SHA-1 differs from the listing", async () => {
    const { github, load } = setup();
    github.hook((url) =>
      url.pathname.endsWith("/packages/a/src/index.ts")
        ? new Response(SECRET.replace("SOURCE", "SOURCX"))
        : undefined
    );
    const error = await failure(load());
    expect(error.code).toBe("integrity");
    expect(error.message).not.toContain("SECRET");
  });

  it("refuses a response redirected away from GitHub's hosts", async () => {
    const { github, load } = setup();
    github.hook((url) => {
      if (url.host !== "raw.githubusercontent.com") {
        return;
      }
      const response = new Response("x");
      Object.defineProperty(response, "url", {
        value: "https://cdn.example.com/x",
      });
      return response;
    });
    expect((await failure(load())).code).toBe("unexpected-origin");
  });

  it("reports a network failure without the request's details", async () => {
    const { github, load } = setup();
    github.hook(() => Promise.reject(new TypeError("Failed to fetch")));
    const error = await failure(load());
    expect(error.code).toBe("network");
    expect(error.message).toBe(
      "Could not reach api.github.com for github.com/octo/demo: the browser is offline, the network failed, or the response was blocked cross-origin."
    );
  });

  it("keeps at most `concurrency` downloads in flight", async () => {
    const { github, load } = setup();
    let open = 0;
    let most = 0;
    github.hook(async (url) => {
      if (url.host === "raw.githubusercontent.com") {
        open += 1;
        most = Math.max(most, open);
        await new Promise((resolve) => setTimeout(resolve, 1));
        open -= 1;
      }
    });
    await load({}, { limits: { concurrency: 2 } });
    expect(most).toBe(2);
  });

  it("matches Git's own blob framing", () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha(new TextEncoder().encode("hello\n"))).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a"
    );
    expect(gitBlobSha(new Uint8Array())).toBe(
      "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
    );
  });

  it("classifies analysis inputs by name only", () => {
    expect(
      [
        "a.ts",
        "a.d.ts",
        "a.tsx",
        "a.mjs",
        "tsconfig.base.json",
        "bun.lock",
        ".gitignore",
        "pnpm-workspace.yaml",
        "README.md",
        "a.png",
        "a.yaml",
        "package-lock.yaml",
      ].filter(isAnalysisInput)
    ).toEqual([
      "a.ts",
      "a.d.ts",
      "a.tsx",
      "a.mjs",
      "tsconfig.base.json",
      "bun.lock",
      ".gitignore",
      "pnpm-workspace.yaml",
    ]);
  });

  it("states its provisional limits", () => {
    expect(PROVISIONAL_GITHUB_LIMITS).toEqual({
      concurrency: 6,
      maxFileBytes: 1_000_000,
      maxFiles: 5000,
      maxScopeDepth: 16,
      maxTotalBytes: 50_000_000,
      maxTreeEntries: 100_000,
    });
  });
});

describe("loadGitHubRepository: abort", () => {
  it("rejects with the reason mid-download, starts nothing more and ignores the late response", async () => {
    const { github, load } = setup();
    const held = deferred<Response>();
    let heldAt = 0;
    github.hook((url) => {
      if (url.pathname.endsWith("/packages/a/package.json")) {
        heldAt = github.requests.length;
        return held.promise;
      }
    });
    const controller = new AbortController();
    const reason = new Error("stop");
    const loading = load(
      {},
      { limits: { concurrency: 1 }, signal: controller.signal }
    );
    while (heldAt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort(reason);
    await expect(loading).rejects.toBe(reason);
    const after = github.requests.length;
    held.resolve(new Response(FILES["packages/a/package.json"]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(github.requests.length).toBe(after);
    expect(after).toBe(heldAt);
    expect(
      github.requests.every(({ init }) => init?.signal !== undefined)
    ).toBe(true);
  });

  it("rejects before any request when already aborted", async () => {
    const { github, load } = setup();
    const controller = new AbortController();
    controller.abort(new Error("early"));
    await expect(load({}, { signal: controller.signal })).rejects.toThrow(
      "early"
    );
    expect(github.requests).toEqual([]);
  });

  it("aborts sibling downloads after the first failure", async () => {
    const { github, load } = setup();
    const siblings: AbortSignal[] = [];
    github.hook((url, { init }) => {
      if (
        url.pathname.endsWith("/package.json") &&
        url.host === "raw.githubusercontent.com"
      ) {
        return new Response("404", { status: 404 });
      }
      if (url.host === "raw.githubusercontent.com" && init?.signal) {
        siblings.push(init.signal);
        return new Promise<Response>(() => undefined);
      }
    });
    const error = await failure(load());
    expect(error.code).toBe("missing-file");
    expect(siblings.length).toBeGreaterThan(0);
    expect(siblings.every((signal) => signal.aborted)).toBe(true);
  });
});
