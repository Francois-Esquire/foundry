import { describe, expect, it, vi } from "vitest";

import { createVirtualSystem } from "../virtual/system";

describe("virtual storage observation", () => {
  it("sees direct writes, shell mutations, and link changes through the same filesystem", async () => {
    const sandbox = createVirtualSystem({ files: { "a.txt": "initial" } });
    const changed = vi.fn();
    const subscription = await sandbox.files.watch(
      "/workspace",
      changed,
      vi.fn()
    );
    await sandbox.files.writeFile("a.txt", "written");
    expect(changed).toHaveBeenCalled();
    for (const command of [
      "echo changed > a.txt",
      "echo appended >> a.txt",
      "mkdir empty",
      "cp a.txt b.txt",
      "mv b.txt c.txt",
      "ln -s a.txt link.txt",
      "rm c.txt",
    ]) {
      changed.mockClear();
      expect(await sandbox.commands.exec(command)).toMatchObject({
        exitCode: 0,
      });
      expect(changed, command).toHaveBeenCalled();
    }
    await subscription.close();
    changed.mockClear();
    await sandbox.commands.exec("echo stopped > a.txt");
    expect(changed).not.toHaveBeenCalled();
  });
});
