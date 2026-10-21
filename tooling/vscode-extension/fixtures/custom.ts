import { assemble, claudeCode } from "@foundry/prompts";

// Not highlighted yet: a grammar cannot tell which dialect `mine.house` is.
// A dialect keyed `claude`, `codex`, or `pi` highlights as that harness.
const mine = assemble({ dialects: { claude: claudeCode, house: claudeCode } });

export const known = mine.claude`/code-review @src`;
export const unknown = mine.house`/code-review @src`;
