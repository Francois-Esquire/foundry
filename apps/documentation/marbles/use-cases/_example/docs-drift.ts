import { agent, artifact, monitor, Output, step } from "@foundry.sh/marbles";
import { z } from "zod";

const finding = z.object({
  claim: z.string(),
  doc: z.string(),
  fix: z.string(),
});
const drift = z.object({ stale: z.array(finding) });
const notes = artifact({ name: "Docs drift", type: "application/json" });

const auditor = agent({
  name: "docs-auditor",
  prompt:
    "Compare the changed files with README.md, AGENTS.md, CLAUDE.md, and docs/. List each statement the change made untrue, with its document path and a one-line fix. Do not edit files.",
});

const audit = step("docs-drift")
  .input(z.object({ paths: z.array(z.string()) }))
  .do(async ({ input, report }) => {
    const output = Output.object({ schema: drift });
    const reply = await auditor.generate(`Changed: ${input.paths.join(", ")}`, {
      output,
    });
    const { stale } = drift.parse(reply.output);
    if (stale.length > 0) {
      const body = stale
        .map((item) => `- ${item.doc}: "${item.claim}". ${item.fix}`)
        .join("\n");
      const title = `${stale.length} statements drifted from the code`;
      await report.artifact(
        notes,
        { "drift.json": JSON.stringify(stale, null, 2) },
        { body, title }
      );
    }
    return { stale: stale.length };
  });

monitor("src/**/*.ts")
  .name("source")
  .every("10m")
  .do(({ files }) => {
    const changed = files
      ? [...files.added, ...files.modified, ...files.removed]
      : [];
    const paths = changed.map((file) => file.path);
    return paths.length > 0 ? audit({}, { paths }) : undefined;
  });
