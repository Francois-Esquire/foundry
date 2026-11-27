import { posix } from "node:path";

import { tagTools } from "@foundry/agents/harness";
import type { Container } from "@foundry/sandbox";
import { DEFAULT_SANDBOX_WORKING_DIRECTORY } from "@foundry/sandbox";
import { createSandboxToolkit } from "@foundry/sandbox/tools";
import type { ToolSet } from "ai";

export type CodingToolsContainer = Pick<Container, "files" | "commands"> & {
  readonly storage?: Container["storage"];
};

const WORKSPACE = DEFAULT_SANDBOX_WORKING_DIRECTORY;

function assertWorkspace(path: string): string {
  if (path !== WORKSPACE && !path.startsWith(`${WORKSPACE}/`)) {
    throw new Error("Coding file path escapes the workspace.");
  }
  return path;
}

export function createCodingTools(container: CodingToolsContainer): ToolSet {
  let canonicalRoot: Promise<void> | undefined;
  const { storage } = container;
  const checkRoot = (): Promise<void> => {
    if (storage === undefined) {
      return Promise.resolve();
    }
    canonicalRoot ??= storage
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
  const isAbsent = async (path: string): Promise<boolean> => {
    const result = await container.commands.exec(
      ["sh", "-c", 'test -e "$1" || test -L "$1"', "check-absent", path],
      { cwd: WORKSPACE }
    );
    return result.exitCode === 1;
  };
  const canonicalPath = async (
    path: string,
    allowMissing = false
  ): Promise<string> => {
    const requested = assertWorkspace(path);
    if (storage === undefined) {
      return requested;
    }
    await checkRoot();
    let candidate = requested;
    const missing: string[] = [];
    while (candidate.length > 0) {
      try {
        const existing = assertWorkspace(await storage.realpath(candidate));
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
