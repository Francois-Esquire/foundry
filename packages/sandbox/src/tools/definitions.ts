import { z } from "zod";

export const DEFAULT_READ_LIMIT = 2000;

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
        "Cancel the command after this many milliseconds; its output is discarded. Processes it started may keep running."
      ),
  }),
};

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

const TOOL_LINES: Record<SandboxToolName, string> = {
  bash: "- `bash` — run a shell command. Prefer the dedicated file tools above when they fit. `timeout` cancels the command and discards its output; processes it started may keep running.",
  cd: "- `cd` — move the working directory. Later relative paths resolve against it, and `bash` runs there. Use it to settle into a subtree instead of repeating a long prefix.",
  edit: "- `edit` — replace an exact string in a file. `old_string` must match uniquely, so include enough surrounding context; set `replace_all` to change every occurrence.",
  glob: "- `glob` — list files matching a glob pattern, as workdir-relative paths.",
  grep: "- `grep` — search file contents. Narrow with `glob` (e.g. `*.ts`) and switch `output_mode` to `files_with_matches` or `count`.",
  read: "- `read` — read a file's contents, returned with line numbers. Use `offset`/`limit` to page through large files.",
  write:
    "- `write` — create or overwrite a file; parent directories are created for you.",
};

const COUNT_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
];

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
