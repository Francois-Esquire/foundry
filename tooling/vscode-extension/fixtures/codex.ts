import { prompts } from "@foundry/prompts";

// Codex mentions a skill with `$name`; `/name` opening the message is a command.
export const review = prompts.codex`/review the staged diff`;
export const skills = prompts.codex`Use $code-review and $plugin:lint on @src/index.ts.`;

// Custom prompts: `/prompts:name`, filled from `$1`, `$ARGUMENTS`, and `$NAME`.
export const custom = prompts.codex`/prompts:draft FILE=notes.md`;
export const placeholders = prompts.codex`Draft $FILE from $1; it costs $$5.`;

// A message that opens with `!` runs in the shell.
export const shell = prompts.codex`!git status --short`;
export const called = prompts.codex("use $review");
