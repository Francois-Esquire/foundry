import { describe, expect, it } from "vitest";
import { normalizeSandboxPath } from "../../path";
import type { Sandbox } from "../../types";
import { SANDBOX_ARGV_FIXTURE, SANDBOX_SHELL_FIXTURE } from "./fixtures";

export interface SandboxContractFixture {
  dispose?(): Promise<void>;
  readonly sandbox: Sandbox;
}

export interface SandboxContractOptions {
  /** A fresh sandbox per case. It must answer both command fixtures. */
  create(): Promise<SandboxContractFixture> | SandboxContractFixture;
  readonly label: string;
}

/** What every backend's files and commands must do, whatever is underneath. */
export function runSandboxContract(options: SandboxContractOptions): void {
  const withSandbox = async (
    body: (sandbox: Sandbox) => Promise<void>
  ): Promise<void> => {
    const fixture = await options.create();
    try {
      await body(fixture.sandbox);
    } finally {
      await fixture.dispose?.();
    }
  };

  describe(`sandbox contract: ${options.label}`, () => {
    it("preserves argv execution and distinct shell execution", () =>
      withSandbox(async (sandbox) => {
        await expect(
          sandbox.commands.exec(SANDBOX_ARGV_FIXTURE)
        ).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "argv value" });
        await expect(
          sandbox.commands.exec(SANDBOX_SHELL_FIXTURE)
        ).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "shell value" });
      }));

    it("round trips text, bytes, and copied directories", () =>
      withSandbox(async (sandbox) => {
        const base = sandbox.workingDirectory;
        const binary = new Uint8Array([0, 1, 127, 255]);

        await sandbox.files.writeFile("text.txt", "portable");
        await sandbox.files.copyIn({
          "tree/binary.dat": binary,
          "tree/nested/value.txt": "nested",
        });

        await expect(sandbox.files.readFile("./text.txt")).resolves.toEqual(
          new TextEncoder().encode("portable")
        );
        await expect(
          sandbox.files.readFile(`${base}/tree/binary.dat`)
        ).resolves.toEqual(binary);
        await expect(sandbox.files.copyOut("tree")).resolves.toEqual({
          [`${base}/tree/binary.dat`]: binary,
          [`${base}/tree/nested/value.txt`]: new TextEncoder().encode("nested"),
        });
      }));

    it("enumerates one level by default and the whole tree on request", () =>
      withSandbox(async (sandbox) => {
        const base = sandbox.workingDirectory;
        await sandbox.files.copyIn({
          "tree/nested/deep.txt": "deep",
          "tree/top.txt": "top",
        });

        expect(new Set(await sandbox.files.list(`${base}/tree`))).toEqual(
          new Set([
            { path: `${base}/tree/top.txt`, type: "file" },
            { path: `${base}/tree/nested`, type: "directory" },
          ])
        );
        expect(
          new Set(await sandbox.files.list(`${base}/tree`, { recursive: true }))
        ).toEqual(
          new Set([
            { path: `${base}/tree/top.txt`, type: "file" },
            { path: `${base}/tree/nested`, type: "directory" },
            { path: `${base}/tree/nested/deep.txt`, type: "file" },
          ])
        );

        // A path that isn't a readable directory degrades to empty, never throws.
        await expect(
          sandbox.files.list(`${base}/tree/top.txt`)
        ).resolves.toEqual([]);
        await expect(sandbox.files.list(`${base}/absent`)).resolves.toEqual([]);

        await expect(sandbox.files.isDirectory(`${base}/tree`)).resolves.toBe(
          true
        );
        await expect(
          sandbox.files.isDirectory(`${base}/tree/top.txt`)
        ).resolves.toBe(false);
        await expect(sandbox.files.isDirectory(`${base}/absent`)).resolves.toBe(
          false
        );
      }));

    it("normalizes portable paths and rejects traversal", () =>
      withSandbox(async (sandbox) => {
        const base = sandbox.workingDirectory;
        expect(normalizeSandboxPath("./tree//value", base)).toBe(
          `${base}/tree/value`
        );
        await expect(
          sandbox.files.writeFile("../../host.txt", "blocked")
        ).rejects.toMatchObject({ code: "invalid-contract" });
      }));
  });
}
