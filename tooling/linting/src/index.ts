import { eslintCompatPlugin, type Plugin, type Rule } from "@oxlint/plugins";
import { RULES, rule } from "./prompts/rules";

export type { PromptsSettings } from "./prompts/settings";

const NAME = "foundry";

const rules: Record<string, Rule> = {};
for (const spec of RULES) {
  rules[`prompts/${spec.name}`] = rule(spec);
}

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
