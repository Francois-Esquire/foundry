import { execFile, execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { catalog } from "~/authoring/catalog";
import { CODEX } from "~/lib/harnesses";
import type { Reply } from "~/lib/models/echo";
import {
  type AdversarialReviewOutput,
  adversarialReview,
} from "../examples/adversarial-review";
import type { MockBindings } from "./helpers/bindings";
import { bindMock } from "./helpers/bindings";
import { declared } from "./helpers/engine";
import { launch } from "./helpers/launch";
import { seedRepository } from "./helpers/repository";

const execFileAsync = promisify(execFile);

type Call = Parameters<Reply>[0];
type Role = "challenger" | "spec" | "standards";

const reviewSteps = {
  assemble: catalog.definitions.get("adversarial-review-assemble"),
  spec: catalog.definitions.get("adversarial-review-spec"),
  standards: catalog.definitions.get("adversarial-review-standards"),
};

const SPEC = "Requirement R1: totals must never be negative.";

let mock: MockBindings | undefined;
const repositories: string[] = [];

afterEach(async () => {
  catalog.reset();
  await mock?.dispose();
  mock = undefined;
  await Promise.all(
    repositories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true }))
  );
});

/**
 * A repository on `feature`, one commit past `main`, with an untracked file
 * and the instruction files the Standards axis should find.
 */
async function fixture(): Promise<string> {
  const root = await realpath(await seedRepository());
  repositories.push(root);
  const git = (...args: string[]) =>
    execFileAsync("git", ["-C", root, ...args]);
  await writeFile(join(root, "AGENTS.md"), "Use early returns.\n");
  await git("add", "AGENTS.md");
  await git("commit", "-m", "rules");
  await git("checkout", "-b", "feature");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "AGENTS.md"), "Name totals clearly.\n");
  await writeFile(
    join(root, "src", "total.ts"),
    "export const total = (a: number) => a - 1;\n"
  );
  await git("add", "src");
  await git("commit", "-m", "total");
  await writeFile(join(root, "src", "draft.ts"), "export {};\n");
  return root;
}

function roleOf(call: Call): Role {
  if (call.schema?.properties?.verdicts) {
    return "challenger";
  }
  return call.prompt.includes("repository's own written standards")
    ? "standards"
    : "spec";
}

const finding = (title: string) => ({
  condition: "a is 0",
  consequence: "total is negative",
  evidence: "a - 1",
  file: "src/total.ts",
  line: 1,
  reference: "R1",
  severity: "major",
  title,
});

/** Scripted replies per role; every call is kept for the assertions. */
function bind(
  replies: Partial<Record<Role, (call: Call) => unknown>>,
  root: string
) {
  const calls: { call: Call; role: Role }[] = [];
  mock = bindMock(
    (call) => {
      const role = roleOf(call);
      calls.push({ call, role });
      const reply = replies[role];
      if (!reply) {
        throw new Error(`no reply scripted for ${role}`);
      }
      return JSON.stringify(reply(call));
    },
    { executors: [CODEX], root }
  );
  return calls;
}

const empty = () => ({ findings: [], inspected: [], unchecked: "" });

it("offers the workflow and its arguments to the launch form", () => {
  const entry = declared()
    .entries()
    .find((item) => item.name === "adversarial-review");
  expect(entry?.kind).toBe("workflow");
  expect(entry?.input.fields.map((field) => field.name)).toEqual([
    "architecture",
    "base",
    "challengerProvider",
    "includeWorkingTree",
    "maxFindings",
    "reviewerProvider",
    "spec",
    "specFile",
    "spyglassState",
    "timeoutMs",
    "worktree",
  ]);
});

it("reviews Standards and Spec separately, and counts only what a fresh challenger confirms", async () => {
  const root = await fixture();
  const calls = bind(
    {
      challenger: (call) =>
        call.prompt.includes('"id": "S1"')
          ? {
              verdicts: [
                {
                  evidence: "line 1",
                  id: "S1",
                  reason: "reproduced",
                  verdict: "confirmed",
                },
                {
                  evidence: "",
                  id: "S2",
                  reason: "the rule says otherwise",
                  verdict: "rejected",
                },
              ],
            }
          : // Answers for an id that was never asked about; P1 gets none.
            {
              verdicts: [
                { evidence: "", id: "S1", reason: "", verdict: "confirmed" },
              ],
            },
      spec: () => ({
        findings: [finding("Negative total")],
        inspected: ["src/total.ts"],
        unchecked: "",
      }),
      standards: () => ({
        findings: [finding("Unclear name"), finding("Nested branch")],
        inspected: ["AGENTS.md", "src/total.ts"],
        unchecked: "tests",
      }),
    },
    root
  );

  const result = await launch<AdversarialReviewOutput>(adversarialReview, {
    spec: SPEC,
    worktree: root,
  });

  expect(result.status).toBe("incomplete");
  expect(result.root).toBe(root);
  expect(result.files.map(({ path, untracked }) => [path, untracked])).toEqual([
    ["src/AGENTS.md", false],
    ["src/total.ts", false],
    ["src/draft.ts", true],
  ]);
  expect(result.instructions).toEqual(["AGENTS.md", "src/AGENTS.md"]);
  expect(
    result.standards.findings.map(({ id, verdict }) => [id, verdict])
  ).toEqual([
    ["S1", "confirmed"],
    ["S2", "rejected"],
  ]);
  expect(result.standards.confirmed).toBe(1);
  expect(result.spec.findings).toEqual([
    expect.objectContaining({
      id: "P1",
      verdict: "unresolved",
      verdictReason: "The challenger returned no verdict for this finding.",
    }),
  ]);
  expect(result.spec.confirmed).toBe(0);

  // Four turns, each on its own session.
  expect(calls.map(({ role }) => role).sort()).toEqual([
    "challenger",
    "challenger",
    "spec",
    "standards",
  ]);
  const sessions = [
    result.standards.review.session,
    result.standards.challenge.session,
    result.spec.review.session,
    result.spec.challenge.session,
  ];
  expect(new Set(sessions).size).toBe(4);
  expect(calls.every(({ call }) => call.cwd === root)).toBe(true);

  // Neither axis sees the other's remit or findings.
  const prompt = (role: Role, has: string) =>
    calls.find(({ call, role: r }) => r === role && call.prompt.includes(has))
      ?.call.prompt ?? "";
  const standardsPrompt = prompt("standards", "Review the change");
  expect(standardsPrompt).toContain("AGENTS.md, src/AGENTS.md");
  expect(standardsPrompt).not.toContain(SPEC);
  expect(standardsPrompt).toContain("+1 -0");
  const specPrompt = prompt("spec", "Review the change");
  expect(specPrompt).toContain(SPEC);
  expect(specPrompt).not.toContain("src/AGENTS.md, ");
  const specChallenge = prompt("challenger", '"id": "P1"');
  expect(specChallenge).not.toContain("Unclear name");
  expect(specChallenge).toContain(SPEC);
});

it("skips the Spec axis without a model call when no spec is given", async () => {
  const root = await fixture();
  const calls = bind({ standards: empty }, root);
  const result = await launch<AdversarialReviewOutput>(adversarialReview, {
    worktree: root,
  });
  expect(result.status).toBe("complete");
  expect(result.spec).toMatchObject({
    reason: expect.stringContaining("No spec was supplied"),
    status: "skipped",
  });
  expect(result.standards).toMatchObject({
    challenge: { status: "skipped" },
    status: "completed",
  });
  expect(calls.map(({ role }) => role)).toEqual(["standards"]);
});

it("keeps one axis's result when the other's reviewer fails", async () => {
  const root = await fixture();
  bind(
    {
      spec: () => {
        throw new Error("provider unavailable");
      },
      standards: empty,
    },
    root
  );
  const result = await launch<AdversarialReviewOutput>(adversarialReview, {
    spec: SPEC,
    worktree: root,
  });
  expect(result.status).toBe("incomplete");
  expect(result.standards.status).toBe("completed");
  expect(result.spec.status).toBe("failed");
  // The streamed turn loses the provider's own message; the SDK reports
  // the reply it could not read.
  expect(result.spec.review.error).toContain("No object generated");
});

it("leaves findings unresolved when the challenge fails", async () => {
  const root = await fixture();
  bind(
    {
      challenger: () => ({ wrong: true }),
      standards: () => ({
        findings: [finding("Unclear name")],
        inspected: [],
        unchecked: "",
      }),
    },
    root
  );
  const result = await launch<AdversarialReviewOutput>(adversarialReview, {
    worktree: root,
  });
  expect(result.status).toBe("incomplete");
  expect(result.standards.status).toBe("incomplete");
  expect(result.standards.challenge.status).toBe("failed");
  expect(result.standards.findings).toEqual([
    expect.objectContaining({
      verdict: "unresolved",
      verdictReason: expect.stringContaining("The challenge failed"),
    }),
  ]);
  expect(result.standards.confirmed).toBe(0);
});

it("fails the run when both axes fail", async () => {
  const root = await fixture();
  bind({}, root);
  await expect(
    launch(adversarialReview, { spec: SPEC, worktree: root })
  ).rejects.toThrow("Both axes failed");
});

it("rejects a base that names no commit before any model call", async () => {
  const root = await fixture();
  const calls = bind({ standards: empty }, root);
  await expect(
    launch(adversarialReview, { base: "no-such-branch", worktree: root })
  ).rejects.toThrow('"no-such-branch" does not name a commit');
  expect(calls).toHaveLength(0);
});

it("rejects a spec file outside the checkout before any model call", async () => {
  const root = await fixture();
  const calls = bind({ standards: empty }, root);
  await expect(
    launch(adversarialReview, { specFile: "../elsewhere.md", worktree: root })
  ).rejects.toThrow("must be inside the checkout");
  expect(calls).toHaveLength(0);
});

it("rejects the findings when the checkout changes during the review", async () => {
  const root = await fixture();
  bind(
    {
      standards: () => {
        // A reviewer that edits despite being told not to.
        execFileSync("git", ["-C", root, "add", "src/draft.ts"]);
        return empty();
      },
    },
    root
  );
  await expect(launch(adversarialReview, { worktree: root })).rejects.toThrow(
    "changed during the review"
  );
});

it("reports Spyglass as unavailable, not missing, when the scan fails", async () => {
  const root = await fixture();
  const calls = bind({ standards: empty }, root);
  const result = await launch<AdversarialReviewOutput>(adversarialReview, {
    architecture: true,
    // A file, not a directory: the scan cannot keep its state there.
    spyglassState: join(root, "AGENTS.md"),
    worktree: root,
  });
  expect(result.standards.architecture?.status).toBe("failed");
  expect(result.standards.status).toBe("completed");
  expect(calls[0]?.call.prompt).toContain(
    "Spyglass architecture evidence was requested but is unavailable"
  );
}, 60_000);

it("gives the Standards reviewer Spyglass reports for the touched package", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "package.json"),
    '{"name":"fixture","version":"0.0.0","type":"module"}\n'
  );
  const state = await realpath(await mkdtemp(join(tmpdir(), "review-sg-")));
  repositories.push(state);
  const calls = bind({ standards: empty }, root);
  const result = await launch<AdversarialReviewOutput>(adversarialReview, {
    architecture: true,
    spyglassState: state,
    worktree: root,
  });
  expect(result.standards.architecture).toMatchObject({
    packages: [{ name: "fixture" }],
    rules: { outcome: "clean" },
    status: "completed",
  });
  const prompt = calls[0]?.call.prompt ?? "";
  expect(prompt).toContain("### fixture");
  expect(prompt).toContain("SEMANTIC SURFACE");
  expect(prompt).toContain("Spyglass rule check");
}, 120_000);

it("rejects spec symlinks that point outside the checkout before model calls", async () => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "review-outside-"));
  repositories.push(outside);
  await writeFile(join(outside, "spec.md"), "Outside sentinel");
  await symlink(join(outside, "spec.md"), join(root, "spec.md"));
  const calls = bind({ standards: empty }, root);
  await expect(
    launch(adversarialReview, {
      specFile: "spec.md",
      worktree: root,
    })
  ).rejects.toThrow("must be inside the checkout");
  expect(calls).toHaveLength(0);
});

it("rejects edits to an already untracked file during review", async () => {
  const root = await fixture();
  bind(
    {
      standards: () => {
        execFileSync("bun", [
          "-e",
          "require('fs').writeFileSync(process.argv[1], 'changed')",
          join(root, "src/draft.ts"),
        ]);
        return empty();
      },
    },
    root
  );
  await expect(launch(adversarialReview, { worktree: root })).rejects.toThrow(
    "changed during the review"
  );
});

it("rejects index-only changes that preserve working-tree content and status", async () => {
  const root = await fixture();
  const path = join(root, "src/total.ts");
  await writeFile(path, "working tree\n");
  execFileSync("git", ["-C", root, "add", "src/total.ts"]);
  await writeFile(path, "unstaged working tree\n");
  bind(
    {
      standards: () => {
        const blob = execFileSync(
          "git",
          ["-C", root, "hash-object", "-w", "--stdin"],
          { input: "replacement index\n" }
        )
          .toString()
          .trim();
        execFileSync("git", [
          "-C",
          root,
          "update-index",
          "--cacheinfo",
          `100644,${blob},src/total.ts`,
        ]);
        return empty();
      },
    },
    root
  );
  await expect(launch(adversarialReview, { worktree: root })).rejects.toThrow(
    "changed during the review"
  );
});

it("leaves contradictory duplicate verdicts unresolved and incomplete", async () => {
  const root = await fixture();
  bind(
    {
      challenger: () => ({
        verdicts: [
          { evidence: "line 1", id: "S1", reason: "yes", verdict: "confirmed" },
          { evidence: "line 1", id: "S1", reason: "no", verdict: "rejected" },
        ],
      }),
      standards: () => ({
        findings: [finding("Unclear name")],
        inspected: [],
        unchecked: "",
      }),
    },
    root
  );
  const result = await launch<AdversarialReviewOutput>(adversarialReview, {
    worktree: root,
  });
  expect(result.status).toBe("incomplete");
  expect(result.standards.status).toBe("incomplete");
  expect(result.standards.confirmed).toBe(0);
  expect(result.standards.findings[0]?.verdict).toBe("unresolved");
});

it("refuses to combine axes when the base ref advances between captures", async () => {
  const root = await fixture();
  bind({ standards: empty }, root);
  const { standards, spec, assemble } = reviewSteps;
  if (!(standards && spec && assemble)) {
    throw new Error("Review steps are not registered.");
  }
  const first = await launch<{ packet: { mergeBase: string } }>(standards, {
    worktree: root,
  });
  execFileSync("git", ["-C", root, "update-ref", "refs/heads/main", "HEAD"]);
  const second = await launch<{ packet: { mergeBase: string } }>(spec, {
    worktree: root,
  });
  expect(first.packet.mergeBase).not.toBe(second.packet.mergeBase);
  await expect(
    launch(assemble, { spec: second, standards: first })
  ).rejects.toThrow("different change ranges");
});
