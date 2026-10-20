import { prompts, ref } from "@foundry/prompts";

// A built-in command opens the message; any other `/name` is a skill.
export const clear = prompts.claude`/clear`;
export const review = prompts.claude`/code-review on @src/auth, then ask @"reviewer (agent)".`;

// Interpolations stay TypeScript; the prompt resumes after each one.
const file = "src/session.ts";
export const interpolated = prompts.claude`Review @${file} with ${ref.skill("security")} and /test-plan.`;

// Template surface: placeholders, harness variables, and inline shell.
export const template = prompts.claude`
  Arguments: $ARGUMENTS, $ARGUMENTS[0], $1, and $topic.
  Read \${CLAUDE_SKILL_DIR}/refs/style.md first.
  Current branch: !\`git branch --show-current\`.
`;

// Plain-string calls read the same way.
export const called = prompts.claude("/compact keep the plan");

// Not prompts: plain text everywhere.
export const path = "a/b/c and user@host";
