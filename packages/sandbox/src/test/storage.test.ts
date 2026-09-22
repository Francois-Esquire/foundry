import { storageChecks } from "@foundry/core/testing/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVirtualSystem } from "../virtual/system";

afterEach(() => vi.restoreAllMocks());

describe("in-memory storage", () => {
  for (const test of storageChecks) {
    it(test.name, async () => {
      const system = createVirtualSystem({
        files: { "kept.txt": "original", "nested/value.txt": "nested" },
      });
      await system.bash.fs.mkdir("/workspace/empty");
      await system.bash.fs.symlink("kept.txt", "/workspace/link");
      await test.run({
        failNextDirectoryRead() {
          vi.spyOn(system.bash.fs, "lstat").mockRejectedValueOnce(
            new Error("entry inspection failed")
          );
        },
        failNextReplacement() {
          vi.spyOn(system.bash.fs, "mv").mockRejectedValueOnce(
            new Error("rename failed")
          );
        },
        root: system.workingDirectory,
        storage: system.files,
      });
    });
  }

  it("shares replacement bytes with commands and preserves file permissions", async () => {
    const system = createVirtualSystem({ files: { "kept.txt": "original" } });
    await system.bash.fs.chmod("/workspace/kept.txt", 0o755);
    await system.files.replaceFile(
      "kept.txt",
      new TextEncoder().encode("updated")
    );
    expect(await system.commands.exec("cat kept.txt")).toMatchObject({
      exitCode: 0,
      stdout: "updated",
    });
    expect(await system.bash.fs.stat("/workspace/kept.txt")).toMatchObject({
      mode: 0o755,
    });
    await system.commands.exec("printf command > kept.txt");
    expect(await system.files.readFile("kept.txt")).toEqual(
      new TextEncoder().encode("command")
    );
  });
});
