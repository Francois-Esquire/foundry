import { agent, artifact, monitor } from "@foundry/marbles";

const signals = artifact({
  name: "Factory maintenance signals",
  type: "application/json",
});
const assessor = agent({
  prompt:
    "Assess this change against the repository. Describe the evidence, whether an issue is warranted, and suggested acceptance criteria. Do not edit files or create an issue.",
});

monitor("**/{AGENTS,CLAUDE}.md")
  .every("1m")
  .do(async ({ files, agents, report, run }) => {
    const session = await agents.session(assessor);
    const reply = await session.generate(
      `Inspect instruction drift and relevant Git history: ${JSON.stringify(files)}`
    );
    await report.artifact(
      signals,
      {
        "assessment.md": reply.text,
        "signal.json": JSON.stringify(
          { files, runId: run.id, source: "repository instructions" },
          null,
          2
        ),
      },
      { body: reply.text, title: "Repository instruction assessment" }
    );
  });

const releaseTag = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || !("tag_name" in value)) {
    return;
  }
  return typeof value.tag_name === "string" ? value.tag_name : undefined;
};
monitor("https://api.github.com/repos/oven-sh/bun/releases/latest")
  .every("6h")
  .do(async ({ change, agents, report, run }) => {
    if (change.kind !== "http") {
      return;
    }
    const tag = releaseTag(change.current);
    if (!tag || tag === releaseTag(change.previous)) {
      return;
    }
    const session = await agents.session(assessor);
    const reply = await session.generate(
      `Assess Bun ${tag} for this repository. Read its release notes before proposing upgrade work.`
    );
    await report.artifact(
      signals,
      {
        "assessment.md": reply.text,
        "signal.json": JSON.stringify(
          { runId: run.id, source: "Bun release", tag },
          null,
          2
        ),
      },
      { body: reply.text, title: `Bun ${tag} assessment` }
    );
  });
