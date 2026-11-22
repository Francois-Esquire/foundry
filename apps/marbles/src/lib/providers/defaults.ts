import { claudeCode } from "~/lib/providers/claude-code";
import { codex } from "~/lib/providers/codex";
import type { ProviderPlugin } from "~/lib/providers/plugins";

export const DEFAULT_PROVIDERS: readonly ProviderPlugin[] = [claudeCode, codex];
