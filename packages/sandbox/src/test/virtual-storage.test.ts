import { storageChecks } from "@foundry/core/testing/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVirtualSandbox } from "../virtual/index";

afterEach(() => vi.restoreAllMocks());

describe("in-memory storage", () => {
  for (const test of storageChecks) {
    it(test.name, async () => {
      const sandbox = createVirtualSandbox({
        files: { "kept.txt": "original", "nested/value.txt": "nested" },
      });
      await sandbox.bash.fs.mkdir("/workspace/empty");
      await sandbox.bash.fs.symlink("kept.txt", "/workspace/link");
      await test.run({
        failNextDirectoryRead() {
          vi.spyOn(sandbox.bash.fs, "lstat").mockRejectedValueOnce(
            new Error("entry inspection failed")
          );
        },
        failNextReplacement() {
          vi.spyOn(sandbox.bash.fs, "mv").mockRejectedValueOnce(
            new Error("rename failed")
          );
        },
        root: sandbox.workingDirectory,
        storage: sandbox.files,
      });
    });
  }

  it("shares replacement bytes with commands and preserves file permissions", async () => {
    const sandbox = createVirtualSandbox({ files: { "kept.txt": "original" } });
    await sandbox.bash.fs.chmod("/workspace/kept.txt", 0o755);
    await sandbox.files.replaceFile(
      "kept.txt",
      new TextEncoder().encode("updated")
    );
    expect(await sandbox.commands.exec("cat kept.txt")).toMatchObject({
      exitCode: 0,
      stdout: "updated",
    });
    expect(await sandbox.bash.fs.stat("/workspace/kept.txt")).toMatchObject({
      mode: 0o755,
    });
    await sandbox.commands.exec("printf command > kept.txt");
    expect(await sandbox.files.readFile("kept.txt")).toEqual(
      new TextEncoder().encode("command")
    );
  });
});
