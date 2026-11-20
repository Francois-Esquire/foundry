import { globToRegExp } from "@foundry/lib/glob";
import type { z } from "zod";
import { DEFAULT_SANDBOX_WORKING_DIRECTORY } from "../constants";
import { SandboxError } from "../errors";
import {
  normalizeSandboxPath,
  normalizeSandboxWorkingDirectory,
} from "../path";
import type { Sandbox, SandboxExecResult, SandboxSearchMatch } from "../types";
import { DEFAULT_READ_LIMIT, MAX_EDIT_RESULT_CHARS } from "./constants";
import type { SandboxToolName } from "./definitions";
import {
  bashDefinition,
  cdDefinition,
  editDefinition,
  globDefinition,
  grepDefinition,
  readDefinition,
  sandboxInstructions,
  sandboxToolDefinitions,
  writeDefinition,
} from "./definitions";
import type { SandboxToolGuards } from "./guards";
import { guardExecute, guardState } from "./guards";

export interface SandboxToolCallOptions {
  readonly abortSignal?: AbortSignal;
}

export interface SandboxTool<Schema extends z.ZodType = z.ZodType> {
  readonly description: string;
  execute(
    input: z.infer<Schema>,
    options: SandboxToolCallOptions
  ): Promise<unknown>;
  readonly inputSchema: Schema;
}

type PathOf = (input: unknown) => string | undefined;

export interface SandboxToolkit {
  readonly instructions: string;
  readonly tools: Record<SandboxToolName, SandboxTool>;
  readonly workingDirectory: string;
}

export interface SandboxPathAccess {
  readonly create: boolean;
}

export interface SandboxToolkitOptions extends SandboxToolGuards {
  readonly resolvePath?: (
    path: string,
    access: SandboxPathAccess
  ) => Promise<string>;
  readonly tools?: readonly SandboxToolName[];
}

export function createSandboxToolkit(
  sandbox: Sandbox,
  options: SandboxToolkitOptions = {}
): SandboxToolkit {
  let workdir = normalizeSandboxWorkingDirectory(sandbox.workingDirectory);
  const resolve = (path: string): string => normalizeSandboxPath(path, workdir);
  const { resolvePath = (path: string) => Promise.resolve(path) } = options;
  const reading = (path: string): Promise<string> =>
    resolvePath(path, { create: false });
  const writing = (path: string): Promise<string> =>
    resolvePath(path, { create: true });

  const guards = guardState(options);
  const defineTool = <Schema extends z.ZodType>(
    name: SandboxToolName,
    definition: { description: string; inputSchema: Schema },
    execute: (
      input: z.infer<Schema>,
      callOptions: SandboxToolCallOptions
    ) => Promise<unknown>,
    pathOf: PathOf = () => undefined
  ): SandboxTool<Schema> => ({
    ...definition,
    execute: guardExecute(name, execute, guards, pathOf),
  });
  const namedPath =
    (field: "file_path" | "path"): PathOf =>
    (input) => {
      const raw = (input as Record<string, unknown> | null)?.[field];
      return typeof raw === "string" ? resolve(raw) : undefined;
    };
  const relative = (path: string): string =>
    path.startsWith(`${workdir}/`) ? path.slice(workdir.length + 1) : path;

  const read = defineTool(
    "read",
    readDefinition,
    async ({ file_path, offset, limit }) => {
      const bytes = await sandbox.files.readFile(
        await reading(resolve(file_path))
      );
      return numberLines(new TextDecoder().decode(bytes), offset, limit);
    },
    namedPath("file_path")
  );

  const write = defineTool(
    "write",
    writeDefinition,
    async ({ file_path, content }) => {
      const path = resolve(file_path);
      await sandbox.files.writeFile(await writing(path), content);
      const bytes = new TextEncoder().encode(content).byteLength;
      return `Wrote ${bytes} byte${bytes === 1 ? "" : "s"} to ${path}`;
    },
    namedPath("file_path")
  );

  const edit = defineTool(
    "edit",
    editDefinition,
    async ({ file_path, old_string, new_string, replace_all }) => {
      if (old_string === new_string) {
        throw new Error("old_string and new_string are identical.");
      }
      const path = resolve(file_path);
      const text = new TextDecoder().decode(
        await sandbox.files.readFile(await reading(path))
      );
      const count = occurrences(text, old_string);
      if (count === 0) {
        throw new Error(`old_string not found in ${path}.`);
      }
      if (count > 1 && !replace_all) {
        throw new Error(
          `old_string is not unique in ${path} (${count} matches) — add surrounding context or set replace_all.`
        );
      }
      const resultChars =
        text.length + count * (new_string.length - old_string.length);
      if (resultChars > Math.max(text.length, MAX_EDIT_RESULT_CHARS)) {
        throw new Error(
          `edit would grow ${path} to ${resultChars} characters, past the ${MAX_EDIT_RESULT_CHARS}-character limit — write the file in smaller steps.`
        );
      }
      await sandbox.files.writeFile(
        await writing(path),
        text.split(old_string).join(new_string)
      );
      const replacements = replace_all ? count : 1;
      return `Edited ${path} (${replacements} replacement${replacements === 1 ? "" : "s"}).`;
    },
    namedPath("file_path")
  );

  const grep = defineTool(
    "grep",
    grepDefinition,
    async ({
      pattern,
      path,
      glob: fileGlob,
      case_insensitive,
      line_numbers,
      output_mode,
    }) => {
      const target = resolve(path ?? workdir);
      if (sandbox.files.search) {
        const matches = await sandbox.files.search(pattern, {
          path: await reading(target),
          ...(fileGlob === undefined ? {} : { glob: fileGlob }),
          caseInsensitive: case_insensitive,
        });
        return formatMatches(matches, relative, output_mode, line_numbers);
      }
      const argv = grepCommand(await reading(target), {
        case_insensitive,
        glob: fileGlob,
        line_numbers,
        output_mode,
        pattern,
      });

      const { stdout, stderr, exitCode } = await sandbox.commands.exec(argv);
      const out = stdout.trimEnd();
      const matches = out === "" ? "No matches found." : out;

      if (fileGlob) {
        if (exitCode !== 0) {
          throw grepError(stderr, exitCode);
        }
        return matches;
      }
      if (exitCode === 0) {
        return matches;
      }
      if (exitCode === 1) {
        return "No matches found.";
      }
      throw grepError(stderr, exitCode);
    },
    namedPath("path")
  );

  const glob = defineTool(
    "glob",
    globDefinition,
    async ({ pattern, path }) => {
      const base = resolve(path ?? workdir);
      const regex = globToRegExp(pattern);
      const entries = await sandbox.files.list(await reading(base), {
        recursive: true,
      });
      const prefix = base === "/" ? "/" : `${base}/`;
      const found = entries
        .filter((entry) => entry.type === "file")
        .filter((entry) => regex.test(entry.path.slice(prefix.length)))
        .map((entry) => relative(entry.path));
      return found.length === 0 ? "No files found." : found.join("\n");
    },
    namedPath("path")
  );

  const cd = defineTool(
    "cd",
    cdDefinition,
    async ({ path }) => {
      const target = changeDirectory(path, workdir);
      if (!(await sandbox.files.isDirectory(await reading(target)))) {
        throw new SandboxError(
          "invalid-contract",
          `sandbox working directory does not exist or is not a directory: ${target}`,
          { details: { path: target } }
        );
      }
      const entries = await sandbox.files.list(await reading(target));
      workdir = target;
      return entries.length === 0
        ? `Working directory is now ${target} (it is empty, or not a directory).`
        : `Working directory is now ${target} (${String(entries.length)} entries).`;
    },
    () => workdir
  );

  const bash = defineTool(
    "bash",
    bashDefinition,
    async ({ command, timeout }, { abortSignal }) => {
      const onTimeout =
        timeout === undefined ? undefined : new AbortController();
      const timer = onTimeout
        ? setTimeout(() => {
            onTimeout.abort();
          }, timeout)
        : undefined;
      try {
        const result = await sandbox.commands.exec(command, {
          cwd: workdir,
          ...signalOption(combineSignals(abortSignal, onTimeout?.signal)),
        });
        return formatExec(result);
      } catch (error) {
        if (onTimeout?.signal.aborted) {
          return `Command timed out after ${timeout}ms (the process may still be running in the sandbox).`;
        }
        throw error;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    }
  );

  return {
    instructions: sandboxInstructions(workdir, options.tools),
    // biome-ignore assist/source/useSortedKeys: Tool enumeration preserves the established prompt order.
    tools: { read, write, edit, grep, glob, cd, bash },
    get workingDirectory(): string {
      return workdir;
    },
  };
}

export type SandboxToolSchema<Schema extends z.ZodType = z.ZodType> = Omit<
  SandboxTool<Schema>,
  "execute"
>;

export interface SandboxToolSchemas {
  readonly instructions: string;
  readonly tools: Record<SandboxToolName, SandboxToolSchema>;
}

export function createSandboxToolSchemas(
  options: { workingDirectory?: string } = {}
): SandboxToolSchemas {
  const workdir = options.workingDirectory ?? DEFAULT_SANDBOX_WORKING_DIRECTORY;
  return {
    instructions: sandboxInstructions(workdir),
    tools: { ...sandboxToolDefinitions },
  };
}

function numberLines(
  text: string,
  offset = 1,
  limit = DEFAULT_READ_LIMIT
): string {
  if (text === "") {
    return "(empty file)";
  }
  const lines = text.split("\n");
  const start = Math.max(1, offset);
  const slice = lines.slice(start - 1, start - 1 + limit);
  if (slice.length === 0) {
    return "(no lines in range)";
  }
  return slice
    .map((line, index) => `${String(start + index).padStart(6)}\t${line}`)
    .join("\n");
}

function formatMatches(
  matches: readonly SandboxSearchMatch[],
  relative: (path: string) => string,
  outputMode: "content" | "files_with_matches" | "count",
  lineNumbers: boolean
): string {
  if (matches.length === 0) {
    return "No matches found.";
  }
  if (outputMode === "files_with_matches") {
    return [...new Set(matches.map((match) => relative(match.path)))].join(
      "\n"
    );
  }
  if (outputMode === "count") {
    const counts = new Map<string, number>();
    for (const match of matches) {
      const path = relative(match.path);
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    return [...counts].map(([path, n]) => `${path}:${n}`).join("\n");
  }
  return matches
    .map((match) =>
      lineNumbers
        ? `${relative(match.path)}:${match.line}:${match.text}`
        : `${relative(match.path)}:${match.text}`
    )
    .join("\n");
}

function changeDirectory(input: string, workdir: string): string {
  const parts = input.startsWith("/")
    ? []
    : workdir.split("/").filter((part) => part !== "");
  for (const part of input.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return normalizeSandboxWorkingDirectory(`/${parts.join("/")}`);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function grepCommand(
  target: string,
  input: Omit<z.infer<typeof grepDefinition.inputSchema>, "path">
): string[] {
  const flags: string[] = [];
  if (input.case_insensitive) {
    flags.push("-i");
  }
  if (input.output_mode === "files_with_matches") {
    flags.push("-l");
  } else if (input.output_mode === "count") {
    flags.push("-c");
  } else if (input.line_numbers) {
    flags.push("-n");
  }
  if (input.glob) {
    return [
      "find",
      target,
      "-type",
      "f",
      "-name",
      input.glob,
      "-exec",
      "grep",
      ...flags,
      "-e",
      input.pattern,
      "{}",
      "+",
    ];
  }
  return ["grep", "-r", ...flags, "-e", input.pattern, target];
}

function grepError(stderr: string, exitCode: number): SandboxError {
  return new SandboxError(
    "provider-failed",
    `grep failed: ${stderr.trim() || `exit ${exitCode}`}`,
    { details: { exitCode } }
  );
}

function combineSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const present = signals.filter((signal) => signal !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  if (present.length === 1) {
    return present[0];
  }
  return AbortSignal.any(present);
}

function signalOption(signal: AbortSignal | undefined): {
  signal?: AbortSignal;
} {
  return signal === undefined ? {} : { signal };
}

function formatExec(result: SandboxExecResult): string {
  const sections: string[] = [];
  if (result.stdout) {
    sections.push(result.stdout.trimEnd());
  }
  if (result.stderr) {
    sections.push(`[stderr]\n${result.stderr.trimEnd()}`);
  }
  if (result.exitCode !== 0) {
    sections.push(`[exit code ${result.exitCode}]`);
  }
  return sections.length > 0 ? sections.join("\n") : "(no output)";
}
