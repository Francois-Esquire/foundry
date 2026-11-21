import { describe, expect, it } from "vitest";
import type { GitHubRepositoryInput } from "../../src/lib/github-request";
import {
  parseGitHubRepositoryInput,
  RepositoryInputError,
} from "../../src/lib/github-request";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const problems = (input: GitHubRepositoryInput): readonly string[] => {
  try {
    parseGitHubRepositoryInput(input);
  } catch (error) {
    if (error instanceof RepositoryInputError) {
      return error.problems;
    }
    throw error;
  }
  throw new Error("accepted");
};

describe("parseGitHubRepositoryInput", () => {
  it.each([
    ["https://github.com/octo/repo", "octo", "repo"],
    ["https://github.com/octo/repo/", "octo", "repo"],
    ["https://github.com/octo/repo.git", "octo", "repo"],
    ["  https://github.com/Octo-Org/my.repo_1  ", "Octo-Org", "my.repo_1"],
  ])("accepts the repository root %s", (url, owner, repo) => {
    expect(parseGitHubRepositoryInput({ url })).toEqual({
      owner,
      ref: null,
      repo,
      scope: null,
    });
  });

  it("takes an explicit ref and scope beside a root URL", () => {
    expect(
      parseGitHubRepositoryInput({
        ref: "release/v2",
        scope: "packages/core/",
        url: "https://github.com/octo/repo",
      })
    ).toEqual({
      owner: "octo",
      ref: "release/v2",
      repo: "repo",
      scope: "packages/core",
    });
  });

  it("takes a one-segment /tree/ ref and a /commit/ SHA", () => {
    expect(
      parseGitHubRepositoryInput({
        url: "https://github.com/octo/repo/tree/main",
      })
    ).toMatchObject({ ref: "main", scope: null });
    expect(
      parseGitHubRepositoryInput({
        url: `https://github.com/octo/repo/commit/${SHA.toUpperCase()}`,
      })
    ).toMatchObject({ ref: SHA, scope: null });
  });

  it("splits a /tree/ URL whose first segment is a full commit SHA", () => {
    expect(
      parseGitHubRepositoryInput({
        url: `https://github.com/octo/repo/tree/${SHA}/packages/core`,
      })
    ).toMatchObject({ ref: SHA, scope: "packages/core" });
  });

  it("refuses an ambiguous /tree/ path instead of guessing branch or directory", () => {
    const url = "https://github.com/octo/repo/tree/feature/x/apps/web";
    expect(problems({ url })).toEqual([
      expect.stringContaining("is ambiguous"),
    ]);
    expect(parseGitHubRepositoryInput({ ref: "feature/x", url })).toMatchObject(
      {
        ref: "feature/x",
        scope: "apps/web",
      }
    );
    expect(
      parseGitHubRepositoryInput({ ref: "feature/x/apps/web", url })
    ).toMatchObject({
      ref: "feature/x/apps/web",
      scope: null,
    });
    expect(problems({ ref: "other", url })).toEqual([
      "the ref field does not match the start of the /tree/ path",
    ]);
  });

  it("refuses fields that disagree with the URL", () => {
    expect(
      problems({
        ref: "main",
        url: `https://github.com/octo/repo/commit/${SHA}`,
      })
    ).toEqual(["the ref field disagrees with the commit in the URL"]);
    expect(
      problems({
        scope: "apps/api",
        url: `https://github.com/octo/repo/tree/${SHA}/apps/web`,
      })
    ).toEqual(["the scope field disagrees with the directory in the URL"]);
  });

  it.each([
    ["http://github.com/octo/repo", "only https:// URLs are accepted"],
    [
      "https://gitlab.com/octo/repo",
      "only public repositories on github.com are supported; other hosts are not",
    ],
    [
      "https://www.github.com/octo/repo",
      "only public repositories on github.com are supported; other hosts are not",
    ],
    [
      "https://github.com:8443/octo/repo",
      "the URL names a port; use https://github.com/...",
    ],
    [
      "https://github.com/octo/repo/blob/main/README.md",
      "only repository root, /tree/{ref}[/{directory}] and /commit/{sha} URLs are supported",
    ],
    [
      "https://github.com/octo/repo/issues",
      "only repository root, /tree/{ref}[/{directory}] and /commit/{sha} URLs are supported",
    ],
    [
      "https://github.com/octo",
      "the repository name is not a valid GitHub repository name",
    ],
    [
      "https://github.com/-octo/repo",
      "the owner is not a valid GitHub user or organization name",
    ],
    [
      "https://github.com/octo/%E0%A4%A",
      "the URL path has an empty or invalid segment",
    ],
    [
      "https://github.com/octo/%2e%2e",
      "the repository name is not a valid GitHub repository name",
    ],
    [
      "https://github.com/octo/a%2Fb",
      "the repository name is not a valid GitHub repository name",
    ],
    [
      "https://github.com/octo/repo.git/tree/main",
      "a .git suffix is accepted only on a repository root URL",
    ],
    [
      "https://github.com/octo/repo/commit/abc123",
      "a /commit/ URL must name a full 40-character commit SHA",
    ],
    [
      "git@github.com:octo/repo.git",
      "the repository must be an https://github.com/{owner}/{repository} URL",
    ],
    [
      "github.com/octo/repo",
      "the repository must be an https://github.com/{owner}/{repository} URL",
    ],
  ])("refuses %s", (url, problem) => {
    expect(problems({ url })).toContain(problem);
  });

  it("never repeats credentials, tokens or the pasted URL in a refusal", () => {
    const secret = "ghp_SECRETSECRETSECRET";
    for (const url of [
      `https://user:${secret}@github.com/octo/repo`,
      `https://${secret}@github.com/octo/repo`,
      `https://github.com/octo/repo?access_token=${secret}`,
      `https://github.com/octo/repo#${secret}`,
    ]) {
      let message = "";
      try {
        parseGitHubRepositoryInput({ url });
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("Unsupported repository input");
      expect(message).not.toContain(secret);
      expect(message).not.toContain("octo/repo");
    }
  });

  it.each([
    ["a ref with ..", { ref: "a..b" }],
    ["a ref with a space", { ref: "my branch" }],
    ["a ref starting with -", { ref: "-rf" }],
    ["a ref ending in .lock", { ref: "main.lock" }],
    ["a ref with a control character", { ref: "ma\u0001in" }],
    ["an empty ref", { ref: "" }],
  ])("refuses %s", (_label, fields) => {
    expect(
      problems({ ...fields, url: "https://github.com/octo/repo" })
    ).toEqual(["the ref field is not a valid Git branch, tag or commit name"]);
  });

  it.each(["../x", "a/../b", "/abs", "a//b", ".git/hooks", "a\\b", "./a"])(
    "refuses the scope %s",
    (scope) => {
      expect(problems({ scope, url: "https://github.com/octo/repo" })).toEqual([
        'the scope must be a repository-relative directory without empty, ".", ".." or ".git" segments',
      ]);
    }
  );

  it("refuses a URL that is not text", () => {
    expect(problems({ url: 42 } as unknown as GitHubRepositoryInput)).toEqual([
      "the repository URL must be text",
    ]);
  });
});
