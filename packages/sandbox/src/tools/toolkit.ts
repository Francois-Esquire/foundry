/**
 * The sandbox toolkit: one set of tools — `read`, `write`, `edit`, `grep`,
 * `glob`, `cd`, `bash` — bound to a {@link Sandbox}'s facets rather than to
 * any one provider. Whatever the environment underneath (container,
 * web-container, host, or anything that binds the same facets), the
 * agent-facing surface is identical.
 *
 * Where each tool lands:
 *
 * - `read`, `write`, `edit`, `glob` go through the filesystem facet. `glob` is
 *   enumeration (`files.list`) plus a pattern match, so it needs nothing from
 *   the provider beyond the primitive every one of them implements.
 * - `grep` and `bash` go through the command facet. `grep` is a *specialized
 *   exec*: a formal definition whose argv this module builds, not a filesystem
 *   primitive every provider would have to reimplement.
 * - `cd` checks the filesystem before moving this module's working directory —
 *   what every relative path resolves against and where `bash` runs.
 *
 * This module deliberately imports nothing from `node:` — path handling comes
 * from `normalizeSandboxPath`, and the AI SDK is not a dependency: the tools
 * are plain `{ description, inputSchema, execute }` records, which is exactly
 * what an SDK tool is structurally.
 */

import { globToRegExp } from "@foundry/lib/glob";
import type { z } from "zod";
import { DEFAULT_SANDBOX_WORKING_DIRECTORY } from "../constants";
import { SandboxError } from "../errors";
import {
  normalizeSandboxPath,
  normalizeSandboxWorkingDirectory,
} from "../path";
import type { Sandbox, SandboxExecResult, SandboxSearchMatch } from "../types";
import { DEFAULT_READ_LIMIT } from "./constants";
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

/**
 * The slice of a tool-call's options this toolkit reads. Structurally a
 * subset of the AI SDK's own execution options, so a compiled tool can pass
 * its own without this package depending on the SDK.
 */
export interface SandboxToolCallOptions {
  readonly abortSignal?: AbortSignal;
}

/** One tool: a description, an input schema, and what to run. */
export interface SandboxTool<Schema extends z.ZodType = z.ZodType> {
  readonly description: string;
  execute(
    input: z.infer<Schema>,
    options: SandboxToolCallOptions
  ): Promise<unknown>;
  readonly inputSchema: Schema;
}

/** The path a call named, for the audit record only — never for gating. */
type PathOf = (input: unknown) => string | undefined;

export interface SandboxToolkit {
  readonly instructions: string;
  /** All of them, always — keyed rather than indexed, so a caller reaching for
   *  one by name gets it, not `T | undefined`. */
  readonly tools: Record<SandboxToolName, SandboxTool>;
  /** Where relative paths currently resolve. Moves when `cd` runs, so a host
   *  showing the agent's location reads it per call rather than caching it. */
  readonly workingDirectory: string;
}

/** What a {@link SandboxToolkitOptions.resolvePath} call may do with the path. */
export interface SandboxPathAccess {
  /** True when the call may create the path, so it need not exist yet. */
  readonly create: boolean;
}

export interface SandboxToolkitOptions extends SandboxToolGuards {
  /**
   * Maps every path a tool hands to the sandbox, after it has resolved against
   * the working directory. A host that jails the agent canonicalizes or refuses
   * here, in one place, instead of wrapping each facet method. Messages and
   * audit records keep the resolved path. Default: the path unchanged.
   */
  readonly resolvePath?: (
    path: string,
    access: SandboxPathAccess
  ) => Promise<string>;
  /**
   * Which tools the caller intends to mount. The toolkit still builds all seven
   * — a caller passes on only what it wants — but the instruction block
   * narrows to match, so an agent is never told about a tool it does not
   * have. A read-only mount is `["read", "grep", "glob"]`.
   */
  readonly tools?: readonly SandboxToolName[];
}

/** Build the sandbox tools over one {@link Sandbox}. Relative paths resolve
 *  against its working directory. */
export function createSandboxToolkit(
  sandbox: Sandbox,
  options: SandboxToolkitOptions = {}
): SandboxToolkit {
  let workdir = normalizeSandboxWorkingDirectory(sandbox.workingDirectory);
  const resolve = (path: string): string => normalizeSandboxPath(path, workdir);
  const { resolvePath = (path: string) => Promise.resolve(path) } = options;
  /** The path a facet call receives: resolved, then through the host policy. */
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
  /** Most tools name their subject in one of these two fields. */
  const namedPath =
    (field: "file_path" | "path"): PathOf =>
    (input) => {
      const raw = (input as Record<string, unknown> | null)?.[field];
      return typeof raw === "string" ? resolve(raw) : undefined;
    };
  /** Report paths relative to the workdir — what the model asked in. */
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
      // split/join avoids String.replace's substitution pitfalls
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
      // An environment that implements `search` does so because running a
      // command here would be wrong, not slow — see the facet's own note.
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
        // find: non-zero is error; grep's no-match doesn't propagate through -exec
        if (exitCode !== 0) {
          throw grepError(stderr, exitCode);
        }
        return matches;
      }
      // grep exit codes: 0=matches, 1=no-match, >=2=error
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

/**
 * The same tools with no `execute`, so the caller's own loop intercepts
 * each call and runs it wherever the sandbox actually lives — the shape a
 * browser client needs, where the environment is on the other side of the
 * boundary. Identical definitions to {@link createSandboxToolkit}, so a model
 * cannot tell the two bindings apart.
 */
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

/** Render facet-native search matches in the same three shapes `grep`'s
 *  `output_mode` produces from a command's stdout. */
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

/**
 * Resolve a `cd` target against the current directory, collapsing `..`.
 *
 * Every other tool goes through `normalizeSandboxPath`, which refuses `..`
 * outright — a cheap first line of defense that assumes you never move. `cd`
 * is the one tool whose whole point is moving, so it collapses the traversal
 * lexically here and hands the environment a plain absolute path. Nothing is
 * weakened by that: the facet jails the result exactly as it jails every other
 * path, and `..` past the top lands on `/`, which a rooted environment refuses.
 */
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
  // Re-normalize so a NUL or a backslash is refused the same way it would be
  // on any other path, rather than reaching the environment.
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
  // Busybox grep lacks --include, so find selects files when a glob is present.
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

/** `exactOptionalPropertyTypes` forbids passing an explicit `undefined`. */
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
