import { observe, tasks } from "@foundry.sh/marbles";

observe(tasks, async (event) => {
  for (const change of event.tasks) {
    const entered =
      change.after?.tags.includes("intake") &&
      !change.before?.tags.includes("intake");
    if (!entered) {
      continue;
    }

    const current = await tasks.get(change.id);
    if (
      current?.status !== "open" ||
      !current.tags.includes("intake") ||
      current.metadata.intakeRecorded === true
    ) {
      continue;
    }

    await tasks.update(
      current.id,
      { metadata: { intakeRecorded: true } },
      { expectedUpdatedAt: current.updatedAt }
    );
  }
});
