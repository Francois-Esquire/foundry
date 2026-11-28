import { tagTools } from "@foundry/agents/harness";
import type { Container } from "@foundry/sandbox";
import { DEFAULT_SANDBOX_WORKING_DIRECTORY } from "@foundry/sandbox";
import { createSandboxToolkit } from "@foundry/sandbox/tools";
import type { ToolSet } from "ai";

export type CodingToolsContainer = Pick<Container, "files" | "commands"> & {
  readonly storage?: Container["storage"];
};

const WORKSPACE = DEFAULT_SANDBOX_WORKING_DIRECTORY;

function posixNormalize(path: string): string {
  const absolute = path.startsWith("/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push("..");
      }
    } else {
      segments.push(segment);
    }
  }
  const joined = segments.join("/");
  if (absolute) {
    return `/${joined}`;
  }
  return joined || ".";
}

function posixJoin(...parts: readonly string[]): string {
  const nonEmpty = parts.filter((part) => part.length > 0);
  if (nonEmpty.length === 0) {
    return ".";
  }
  return posixNormalize(nonEmpty.join("/"));
}

function posixBasename(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") {
    end -= 1;
  }
  if (end === 1 && path[0] === "/") {
    return "";
  }
  const slash = path.lastIndexOf("/", end - 1);
  return slash === -1 ? path.slice(0, end) : path.slice(slash + 1, end);
}

function posixDirname(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") {
    end -= 1;
  }
  const slash = path.lastIndexOf("/", end - 1);
  if (slash === -1) {
    return ".";
  }
  if (slash === 0) {
    return "/";
  }
  let dirEnd = slash;
  while (dirEnd > 1 && path[dirEnd - 1] === "/") {
    dirEnd -= 1;
  }
  return path.slice(0, dirEnd);
}

function assertWorkspace(path: string): string {
  if (path !== WORKSPACE && !path.startsWith(`${WORKSPACE}/`)) {
    throw new Error("Coding file path escapes the workspace.");
  }
  return path;
}

export function createCodingTools(container: CodingToolsContainer): ToolSet {
  let canonicalRoot: Promise<void> | undefined;
  const resolveRealpath = (target: string): Promise<string> | undefined =>
    container.storage
      ? container.storage.realpath(target)
      : container.files.realpath?.(target);
  const checkRoot = (): Promise<void> => {
    canonicalRoot ??= (() => {
      const resolved = resolveRealpath(WORKSPACE);
      if (resolved === undefined) {
        return Promise.resolve();
      }
      return resolved
        .then((real) => {
          if (real !== WORKSPACE) {
            throw new Error("Coding workspace root must be canonical.");
          }
        })
        .catch((error: unknown) => {
          canonicalRoot = undefined;
          throw error;
        });
    })();
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
    if (
      container.storage === undefined &&
      container.files.realpath === undefined
    ) {
      return requested;
    }
    await checkRoot();
    let candidate = requested;
    const missing: string[] = [];
    while (candidate.length > 0) {
      try {
        const resolved = resolveRealpath(candidate);
        if (resolved === undefined) {
          return assertWorkspace(posixJoin(candidate, ...missing.reverse()));
        }
        const existing = assertWorkspace(await resolved);
        return assertWorkspace(posixJoin(existing, ...missing.reverse()));
      } catch (error) {
        if (
          !allowMissing ||
          candidate === WORKSPACE ||
          !(await isAbsent(candidate))
        ) {
          throw error;
        }
        missing.push(posixBasename(candidate));
        candidate = posixDirname(candidate);
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
