import type { ProviderPlugin } from "~/lib/providers/plugins";
import { claudeCode } from "~/providers/claude-code";
import { codex } from "~/providers/codex";
import { pi } from "~/providers/pi";

export const DEFAULT_PROVIDERS: readonly ProviderPlugin[] = [
  claudeCode,
  codex,
  pi,
];
