import type { SandboxToolName } from "./definitions";

/** Max lines `read` returns when `limit` is unset (named in its description). */
export const DEFAULT_READ_LIMIT = 2000;

/** One line per tool, for the instruction block. */
export const TOOL_LINES: Record<SandboxToolName, string> = {
  bash: "- `bash` — run a shell command. Prefer the dedicated file tools above when they fit. `timeout` stops waiting for output but does not kill the process.",
  cd: "- `cd` — move the working directory. Later relative paths resolve against it, and `bash` runs there. Use it to settle into a subtree instead of repeating a long prefix.",
  edit: "- `edit` — replace an exact string in a file. `old_string` must match uniquely, so include enough surrounding context; set `replace_all` to change every occurrence.",
  glob: "- `glob` — list files matching a glob pattern, as workdir-relative paths.",
  grep: "- `grep` — search file contents. Narrow with `glob` (e.g. `*.ts`) and switch `output_mode` to `files_with_matches` or `count`.",
  read: "- `read` — read a file's contents, returned with line numbers. Use `offset`/`limit` to page through large files.",
  write:
    "- `write` — create or overwrite a file; parent directories are created for you.",
};

export const COUNT_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
];

export const DEFAULT_LIMITS = {
  maxCallsPerMinute: 120,
  maxOutputChars: 50_000,
} as const;
