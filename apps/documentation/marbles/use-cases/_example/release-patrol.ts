import { agent, monitor, tasks, usage } from "@foundry.sh/marbles";

type Release = { tag_name?: string } | null;

const patrol = agent("release-patrol", async ({ provider }) => {
  const left = await usage.share("anthropic");
  return {
    prompt:
      "Read the release notes and this repository. List the changes the repository needs, or reply with exactly: none. Do not edit files.",
    provider:
      provider ?? (left !== undefined && left < 0.2 ? "codex" : "claude-code"),
  };
});

monitor("https://api.github.com/repos/oven-sh/bun/releases/latest")
  .name("bun-release")
  .every("6h")
  .do(async ({ change }) => {
    if (change.kind !== "http") {
      return;
    }
    const tag = (change.current as Release)?.tag_name;
    if (!tag || tag === (change.previous as Release)?.tag_name) {
      return;
    }
    const reply = await patrol.generate(`Bun ${tag} was released.`);
    if (reply.text.trim().toLowerCase() !== "none") {
      await tasks.create({
        description: reply.text,
        tags: ["upgrade"],
        title: `Adopt Bun ${tag}`,
      });
    }
  });
