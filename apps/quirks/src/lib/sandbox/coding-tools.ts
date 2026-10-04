import { posix } from "node:path";

import { tagTools } from "@foundry/agents/harness";
import type { Container } from "@foundry/sandbox/container/containers";
import { normalizeSandboxPath } from "@foundry/sandbox/path";
import { createSandboxToolkit } from "@foundry/sandbox/tools/toolkit";
import type { ToolSet } from "ai";

export type CodingToolsContainer = Pick<
  Container,
  "files" | "commands" | "workingDirectory"
>;

function assertWorkspace(path: string, workspace: string): string {
  if (path !== workspace && !path.startsWith(`${workspace}/`)) {
    throw new Error("Coding file path escapes the workspace.");
  }
  return path;
}

/** File tools stay within the guest workspace. bash has the authority of the whole VM. */
export function createCodingTools(
  container: CodingToolsContainer,
  options: { workspacePath?: string } = {}
): ToolSet {
  const workspace = normalizeSandboxPath(
    options.workspacePath ?? "/workspace",
    "/"
  );
  const canonicalPath = async (
    path: string,
    allowMissing = false
  ): Promise<string> => {
    const requested = assertWorkspace(
      normalizeSandboxPath(path, workspace),
      workspace
    );
    const canonicalWorkspace = await container.files.realpath(workspace);
    if (canonicalWorkspace !== workspace) {
      throw new Error("Coding workspace root must be canonical.");
    }
    let candidate = requested;
    const missing: string[] = [];
    while (candidate.length > 0) {
      try {
        const existing = assertWorkspace(
          await container.files.realpath(candidate),
          workspace
        );
        return assertWorkspace(
          posix.join(existing, ...missing.reverse()),
          workspace
        );
      } catch (error) {
        if (!allowMissing || candidate === workspace) {
          throw error;
        }
        const exists = await container.commands.exec(
          ["test", "-e", candidate],
          { cwd: workspace }
        );
        const link = await container.commands.exec(["test", "-L", candidate], {
          cwd: workspace,
        });
        if (exists.exitCode !== 1 || link.exitCode !== 1) {
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
        async exec(command, execOptions) {
          if (Array.isArray(command)) {
            // The toolkit's grep is argv, never model-supplied shell text.
            const argv = [...command];
            const targetIndex = argv[0] === "find" ? 1 : argv.length - 1;
            const target = argv[targetIndex];
            if (target === undefined) {
              throw new Error("Missing coding search path.");
            }
            argv[targetIndex] = await canonicalPath(target);
            return container.commands.exec(argv, {
              ...execOptions,
              cwd: workspace,
            });
          }
          return container.commands.exec(command, {
            ...execOptions,
            cwd: workspace,
          });
        },
      },
      files: {
        ...container.files,
        isDirectory: async (path) =>
          container.files.isDirectory(await canonicalPath(path)),
        list: async (path, listOptions) =>
          container.files.list(await canonicalPath(path), listOptions),
        readFile: async (path) =>
          container.files.readFile(await canonicalPath(path)),
        writeFile: async (path, content) =>
          container.files.writeFile(await canonicalPath(path, true), content),
      },
      workingDirectory: workspace,
    },
    { tools: ["read", "write", "edit", "glob", "grep", "bash"] }
  );
  const { read, write, edit, glob, grep, bash } = toolkit.tools;
  return tagTools({ bash, edit, glob, grep, read, write }, "builtin");
}
