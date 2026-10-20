/**
 * `@foundry/linting`: Foundry's lint rules, as one plugin that loads in
 * ESLint and in Oxlint. Rules are grouped by domain: `foundry/prompts/*`
 * checks what a prompt references, through `@foundry/prompts`. Each
 * domain reads its own key under `settings.foundry`. The Biome half of the
 * package is generated GritQL under `biome/`.
 */

import { eslintCompatPlugin, type Plugin, type Rule } from "@oxlint/plugins";
import { RULES, rule } from "./prompts/rules";

export type { PromptsSettings } from "./prompts/settings";

const NAME = "foundry";

const rules: Record<string, Rule> = {};
for (const spec of RULES) {
  rules[`prompts/${spec.name}`] = rule(spec);
}

/** An ESLint flat config object: every rule on, errors as errors and warnings as warnings. */
interface FlatConfig {
  readonly plugins: Readonly<Record<string, Plugin>>;
  readonly rules: Readonly<Record<string, "error" | "warn">>;
}

export interface FoundryPlugin extends Plugin {
  readonly configs: { readonly recommended: FlatConfig };
}

const plugin = eslintCompatPlugin({
  meta: { name: NAME },
  rules,
}) as FoundryPlugin;

const recommended: FlatConfig = {
  plugins: { [NAME]: plugin },
  rules: {
    [`${NAME}/prompts/consumed-by-harness`]: "warn",
    [`${NAME}/prompts/foreign-notation`]: "error",
    [`${NAME}/prompts/template-only`]: "warn",
    [`${NAME}/prompts/unresolved-reference`]: "error",
  },
};

Object.assign(plugin, { configs: { recommended } });

export default plugin;
