/**
 * The formal definitions for the sandbox toolkit — one source of truth for
 * tool shape, shared by every binding of it (executing, or schema-only for a
 * client that intercepts the call and runs it itself). Field names are
 * snake_case.
 *
 * `read`, `write`, `edit`, `grep`, `glob`, `cd`, `bash`. Five come from the
 * container toolkit unchanged; `glob` comes from the host filesystem toolkit
 * unchanged apart from naming the working directory rather than a project
 * root; `cd` is this surface's own, so an agent can settle into a subtree
 * instead of repeating a long prefix on every call.
 *
 * Adding a tool is: a definition here, a line in `sandboxToolDefinitions`, a
 * line in `TOOL_LINES`, and the implementation in `toolkit.ts`. Nothing else
 * enumerates the set — `SandboxToolName`, the instruction block, and the
 * schema-only binding all derive from this record.
 */

import { z } from "zod";

import { COUNT_WORDS, DEFAULT_READ_LIMIT, TOOL_LINES } from "./constants";

export const readDefinition = {
  description:
    "Read a file from the sandbox filesystem. Returns the contents with line numbers; use offset/limit to page through large files.",
  inputSchema: z.object({
    file_path: z
      .string()
      .describe("File to read. Relative paths resolve against the workdir."),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`Max lines to read (default ${DEFAULT_READ_LIMIT}).`),
    offset: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("1-based line number to start reading from."),
  }),
};

export const writeDefinition = {
  description:
    "Write a file to the sandbox filesystem, creating parent directories. Overwrites any existing file.",
  inputSchema: z.object({
    content: z.string().describe("Full contents to write."),
    file_path: z
      .string()
      .describe("File to write. Relative paths resolve against the workdir."),
  }),
};

export const editDefinition = {
  description:
    "Replace an exact string in a sandbox file. old_string must match uniquely unless replace_all is set.",
  inputSchema: z.object({
    file_path: z
      .string()
      .describe("File to edit. Relative paths resolve against the workdir."),
    new_string: z.string().describe("Replacement text."),
    old_string: z.string().min(1).describe("Exact text to replace."),
    replace_all: z
      .boolean()
      .optional()
      .default(false)
      .describe("Replace every occurrence instead of requiring a unique one."),
  }),
};

export const grepDefinition = {
  description:
    "Search file contents in the sandbox with grep (runs inside the sandbox). Returns matching lines by default.",
  inputSchema: z.object({
    case_insensitive: z
      .boolean()
      .optional()
      .default(false)
      .describe("Case-insensitive match (grep -i)."),
    glob: z
      .string()
      .optional()
      .describe("Only search files matching this glob, e.g. '*.ts'."),
    line_numbers: z
      .boolean()
      .optional()
      .default(false)
      .describe("Prefix matches with line numbers (grep -n)."),
    output_mode: z
      .enum(["content", "files_with_matches", "count"])
      .optional()
      .default("content")
      .describe(
        "content: matching lines; files_with_matches: file paths only; count: match count per file."
      ),
    path: z
      .string()
      .optional()
      .describe(
        "File or directory to search. Defaults to the workdir; relative paths resolve against it."
      ),
    pattern: z
      .string()
      .min(1)
      .describe("Pattern passed to grep (POSIX basic regex)."),
  }),
};

export const globDefinition = {
  description:
    "List files in the sandbox matching a glob pattern (e.g. 'src/**/*.ts'). Returns newline-separated workdir-relative paths.",
  inputSchema: z.object({
    path: z
      .string()
      .optional()
      .describe(
        "Directory to match under. Defaults to the workdir; relative paths resolve against it."
      ),
    pattern: z
      .string()
      .min(1)
      .describe("Glob pattern; `**` crosses directories, `*` does not."),
  }),
};

export const cdDefinition = {
  description:
    "Change the working directory. Every later call resolves relative paths against it, and bash commands run in it.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe(
        "Directory to move to. Relative paths resolve against the current working directory, and `..` moves up."
      ),
  }),
};

export const bashDefinition = {
  description:
    "Run a shell command inside the sandbox. Returns stdout, any stderr, and the exit code.",
  inputSchema: z.object({
    command: z.string().min(1).describe("Shell command to execute."),
    timeout: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Stop waiting for the command after this many milliseconds. Note: this abandons the output stream; the process inside the sandbox may keep running."
      ),
  }),
};

/** Every tool definition keyed by name, in canonical order. */
// biome-ignore assist/source/useSortedKeys: Definition enumeration preserves the established prompt order.
export const sandboxToolDefinitions = {
  read: readDefinition,
  write: writeDefinition,
  edit: editDefinition,
  grep: grepDefinition,
  glob: globDefinition,
  cd: cdDefinition,
  bash: bashDefinition,
};

export type SandboxToolName = keyof typeof sandboxToolDefinitions;

/**
 * System-prompt instructions for the mounted tools. Describes exactly the
 * `names` given, in canonical order — an agent told about `write` that has no
 * `write` will try to use it, so a subset mount needs a matching block.
 */
export function sandboxInstructions(
  workingDirectory: string,
  names: readonly SandboxToolName[] = Object.keys(
    sandboxToolDefinitions
  ) as SandboxToolName[]
): string {
  const mounted = (
    Object.keys(sandboxToolDefinitions) as SandboxToolName[]
  ).filter((name) => names.includes(name));
  const canEdit = mounted.includes("edit") && mounted.includes("read");
  const where = mounted.includes("cd")
    ? `the working directory, which starts at \`${workingDirectory}\` and \`cd\` moves,`
    : `the working directory \`${workingDirectory}\``;
  return [
    `You are working in a sandbox with ${COUNT_WORDS[mounted.length] ?? String(mounted.length)} tools for files${mounted.includes("bash") ? " and commands" : ""}. Paths resolve against ${where} unless you pass an absolute path.`,
    "",
    ...mounted.map((name) => TOOL_LINES[name]),
    ...(canEdit
      ? [
          "",
          "Always `read` a file before you `edit` it, so `old_string` matches the current contents exactly.",
        ]
      : []),
  ].join("\n");
}
