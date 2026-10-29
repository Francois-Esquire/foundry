import { Tasks } from "@foundry/tasks";
import { tasks } from "@foundry.sh/marbles";
import { describe, expect, it } from "vitest";

describe("tasks", () => {
  it("is one backlog the package creates and exports", async () => {
    expect(tasks).toBeInstanceOf(Tasks);
    const again = await import("@foundry.sh/marbles");
    expect(again.tasks).toBe(tasks);
  });
});
