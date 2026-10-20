/**
 * `@foundry/eslint-plugin`: ESLint and Oxlint rules that check what a
 * prompt references, through `@foundry/prompts`. A rule finds the prompts
 * in a file (`x.claude\`…\``, `x.codex("…")`, `x.pi\`…\``), hands their
 * text to the package, and reports each finding at its source position.
 * One rule per diagnostic code; `settings.foundryPrompts` is shared.
 */

import { eslintCompatPlugin, type Plugin, type Rule } from "@oxlint/plugins";
import { RULES, rule } from "./rules";

export type { FoundryPromptsSettings } from "./settings";

const NAME = "foundry-prompts";

const rules: Record<string, Rule> = {};
for (const spec of RULES) {
  rules[spec.name] = rule(spec);
}

/** An ESLint flat config object: every rule on, errors as errors and warnings as warnings. */
interface FlatConfig {
  readonly plugins: Readonly<Record<string, Plugin>>;
  readonly rules: Readonly<Record<string, "error" | "warn">>;
}

export interface FoundryPromptsPlugin extends Plugin {
  readonly configs: { readonly recommended: FlatConfig };
}

const plugin = eslintCompatPlugin({
  meta: { name: NAME },
  rules,
}) as FoundryPromptsPlugin;

const recommended: FlatConfig = {
  plugins: { [NAME]: plugin },
  rules: {
    [`${NAME}/no-consumed-by-harness`]: "warn",
    [`${NAME}/no-foreign-notation`]: "error",
    [`${NAME}/no-template-only`]: "warn",
    [`${NAME}/no-unresolved-reference`]: "error",
  },
};

Object.assign(plugin, { configs: { recommended } });

export default plugin;
