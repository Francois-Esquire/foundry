import { prompts } from "@foundry/prompts";

// Pi loads a skill with `/skill:name`; any other `/name` is a prompt template
// unless it is a built-in command.
export const skill = prompts.pi`/skill:review the diff`;
export const command = prompts.pi`/compact`;
export const template = prompts.pi`/draft a release note`;
export const placeholders = prompts.pi`Use $1, then $@ (but not $ARGUMENTS).`;
export const shell = prompts.pi`!ls -la`;
export const mention = prompts.pi`Read @README.md.`;
