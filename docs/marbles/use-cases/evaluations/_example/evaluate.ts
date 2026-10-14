import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  agent,
  artifact,
  defineSkill,
  Output,
  type SessionRef,
  type SessionReply,
  skills,
  step,
} from "@foundry/marbles";
import { z } from "zod";

const cases = [
  {
    code: 'await saveFile("result.txt", text).catch(() => {});\nreturn "saved";',
    expected: ["ignored-write-error"],
    id: "ignored-failure",
  },
  {
    code: 'await saveFile("result.txt", text);\nreturn "saved";',
    expected: [],
    id: "propagated-failure",
  },
];
const findings = z.object({
  findings: z.array(z.object({ evidence: z.string(), rule: z.string() })),
});
const trials = artifact({
  name: "Skill evaluation trials",
  type: "application/json",
});
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

type TrialResult = { id: string; elapsedMs: number } & (
  | {
      passed: boolean;
      output: z.infer<typeof findings>;
      session: SessionRef;
      usage: SessionReply["usage"];
    }
  | { passed: false; error: string }
);

export const evaluateSkill = step("skill-eval")
  .input(
    z.object({
      model: z.string().min(1).optional(),
      provider: z.enum(["codex", "claude-code"]),
      variant: z.enum(["baseline", "candidate"]),
    })
  )
  .config({ timeout: "5m" })
  .do(async ({ input, agents, workspaces, report, run, signal }) => {
    const manifest =
      input.variant === "candidate"
        ? await readFile(
            join(workspaces.current.root, "skills/review/SKILL.md"),
            "utf8"
          )
        : "";
    if (input.variant === "candidate" && !manifest.trim()) {
      throw new Error("The candidate skill is empty.");
    }
    const selected = manifest
      ? skills.none().add(defineSkill({ manifest }))
      : skills.none();
    const reviewer = agent({
      model: input.model,
      name: `eval-reviewer-${digest(JSON.stringify([input, manifest]))}`,
      prompt:
        "Review only the supplied code. Use the supplied skill when applicable. Report ignored-write-error if a failed save is swallowed and success is still returned. Return no findings for code that propagates the failure. Assume saveFile rejects on failure. Do not use tools or edit files.",
      provider: input.provider,
      skills: selected,
    });
    const results: TrialResult[] = [];
    for (const fixture of cases) {
      const started = Date.now();
      try {
        const session = await agents.session(reviewer);
        const reply = await session.generate(fixture.code, {
          output: Output.object({ schema: findings }),
        });
        const output = findings.parse(reply.output);
        const actual = output.findings.map((finding) => finding.rule).sort();
        const passed =
          JSON.stringify(actual) ===
            JSON.stringify([...fixture.expected].sort()) &&
          output.findings.every((finding) => finding.evidence.trim());
        results.push({
          elapsedMs: Date.now() - started,
          id: fixture.id,
          output,
          passed,
          session: session.ref,
          usage: reply.usage,
        });
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        results.push({
          elapsedMs: Date.now() - started,
          error: String(error),
          id: fixture.id,
          passed: false,
        });
      }
    }
    const passed = results.every((result) => result.passed);
    const version = await report.artifact(
      trials,
      {
        "cases.json": JSON.stringify(cases, null, 2),
        "skill.md": manifest || "No declared skill in this baseline.",
        "trial.json": JSON.stringify(
          {
            input,
            passed,
            results,
            runId: run.id,
            skillDigest: manifest ? digest(manifest) : null,
            suiteDigest: digest(JSON.stringify(cases)),
          },
          null,
          2
        ),
      },
      {
        body: results
          .map(
            (result) => `- ${result.id}: ${result.passed ? "passed" : "failed"}`
          )
          .join("\n"),
        title: `Skill evaluation: ${input.variant} ${passed ? "passed" : "failed"}`,
      }
    );
    return { passed, versionId: version.id };
  });
