import { posix } from "node:path";

import { tagTools } from "@foundry/agents/harness";
import { DEFAULT_SANDBOX_WORKING_DIRECTORY } from "@foundry/sandbox/constants";
import type { Container } from "@foundry/sandbox/container/containers";
import { createSandboxToolkit } from "@foundry/sandbox/tools/toolkit";
import type { ToolSet } from "ai";

export type CodingToolsContainer = Pick<Container, "files" | "commands">;

const WORKSPACE = DEFAULT_SANDBOX_WORKING_DIRECTORY;

function assertWorkspace(path: string): string {
  if (path !== WORKSPACE && !path.startsWith(`${WORKSPACE}/`)) {
    throw new Error("Coding file path escapes the workspace.");
  }
  return path;
}

/** File tools stay within the guest workspace. bash has the authority of the whole VM. */
export function createCodingTools(container: CodingToolsContainer): ToolSet {
  /** The workspace root must be its own real path, or nothing under it can be checked; asked once, retried after a failure. */
  let canonicalRoot: Promise<void> | undefined;
  const checkRoot = (): Promise<void> => {
    canonicalRoot ??= container.files
      .realpath(WORKSPACE)
      .then((real) => {
        if (real !== WORKSPACE) {
          throw new Error("Coding workspace root must be canonical.");
        }
      })
      .catch((error: unknown) => {
        canonicalRoot = undefined;
        throw error;
      });
    return canonicalRoot;
  };
  /** Neither a file nor a dangling link: `sh` exits 1 only when both tests fail. */
  const isAbsent = async (path: string): Promise<boolean> => {
    const result = await container.commands.exec(
      ["sh", "-c", 'test -e "$1" || test -L "$1"', "check-absent", path],
      { cwd: WORKSPACE }
    );
    return result.exitCode === 1;
  };
  /** `path` is already resolved against the workspace by the toolkit. */
  const canonicalPath = async (
    path: string,
    allowMissing = false
  ): Promise<string> => {
    const requested = assertWorkspace(path);
    await checkRoot();
    let candidate = requested;
    const missing: string[] = [];
    while (candidate.length > 0) {
      try {
        const existing = assertWorkspace(
          await container.files.realpath(candidate)
        );
        return assertWorkspace(posix.join(existing, ...missing.reverse()));
      } catch (error) {
        if (
          !allowMissing ||
          candidate === WORKSPACE ||
          !(await isAbsent(candidate))
        ) {
          throw error;
        }
        missing.push(posix.basename(candidate));
        candidate = posix.dirname(candidate);
      }
    }
    throw new Error("No canonical workspace parent found.");
  };
  const toolkit = createSandboxToolkit(
    {
      commands: {
        exec: (command, execOptions) =>
          container.commands.exec(command, { ...execOptions, cwd: WORKSPACE }),
      },
      files: container.files,
      workingDirectory: WORKSPACE,
    },
    {
      resolvePath: (path, { create }) => canonicalPath(path, create),
      tools: ["read", "write", "edit", "glob", "grep", "bash"],
    }
  );
  const { read, write, edit, glob, grep, bash } = toolkit.tools;
  return tagTools({ bash, edit, glob, grep, read, write }, "builtin");
}
