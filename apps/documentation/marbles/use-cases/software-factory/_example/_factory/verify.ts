import {
  agent,
  artifact,
  Output,
  type SessionRef,
  step,
  tasks,
  workflow,
} from "@foundry.sh/marbles";
import { z } from "zod";
import { deliver } from "./deliver";
import { sendBack } from "./revise";
import { brief, changeInput } from "./work";

const findings = z.object({
  blockers: z.array(z.object({ file: z.string(), problem: z.string() })),
});
const checked = z.object({ exitCode: z.number(), output: z.string() });

const tests = step("factory-tests")
  .input(changeInput)
  .do(({ input, exec, workspaces }) =>
    workspaces.current.git.withWorktree({ base: input.commit }, async () => {
      const install = await exec(["bun", "install", "--frozen-lockfile"], {
        check: false,
      });
      const result =
        install.exitCode === 0
          ? await exec(["bun", "test"], { check: false })
          : install;
      return {
        exitCode: result.exitCode,
        output: `${result.stdout}${result.stderr}`.slice(-4000),
      };
    })
  );

const reviewer = agent({
  name: "factory-reviewer",
  prompt:
    "Review the checked-out commit against the task and its acceptance criteria. Compare it with your earlier findings. Each blocker names a file and the problem. Separate defects from preferences. Do not edit files.",
});

const review = step("factory-review")
  .input(changeInput)
  .do(({ input, agents, workspaces }) =>
    workspaces.current.git.withWorktree({ base: input.commit }, async () => {
      const earlier = (await tasks.get(input.task))?.metadata.reviewer as
        | SessionRef
        | undefined;
      const session = await agents.session(
        reviewer,
        earlier ? { session: earlier } : {}
      );
      const reply = await session.generate(
        `${await brief(input.task)}\n\nReview ${input.commit}.`,
        {
          output: Output.object({ schema: findings }),
        }
      );
      await tasks.update(input.task, {
        metadata: { reviewer: JSON.parse(JSON.stringify(session.ref)) },
      });
      return findings.parse(reply.output);
    })
  );

const evidence = artifact({
  name: "Factory verification",
  type: "text/markdown",
});

const verdict = step("factory-verdict")
  .input(changeInput.extend({ review: findings, tests: checked }))
  .do(async ({ input, report }) => {
    const passed =
      input.tests.exitCode === 0 && input.review.blockers.length === 0;
    const body = [
      `Tests exited ${input.tests.exitCode}.`,
      ...input.review.blockers.map(
        (blocker) => `- ${blocker.file}: ${blocker.problem}`
      ),
    ].join("\n");
    const version = await report.artifact(
      evidence,
      { "tests.txt": input.tests.output, "verdict.md": body },
      {
        body,
        title: `${input.task} ${passed ? "verified" : "needs changes"} at ${input.commit.slice(0, 8)}`,
      }
    );
    const change = {
      branch: input.branch,
      commit: input.commit,
      task: input.task,
    };
    if (passed) {
      await deliver.launch({ ...change, evidence: version.id });
    } else {
      await sendBack(input.task, body);
    }
    return { evidence: version.id, passed };
  });

export const verify = workflow("factory-verify")
  .input(changeInput)
  .do(({ input }) =>
    verdict.parallel(
      { review: review({}, input), tests: tests({}, input) },
      input
    )
  );
