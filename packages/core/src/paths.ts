export const FOUNDRY_ROOT_ENV = "FOUNDRY_ROOT";

export const FOUNDRY_ROOT_DIR = ".foundry";

export const FOUNDRY_PATHS = {
  artifacts: "{FOUNDRY_ROOT}/artifacts",
  marbles: "{FOUNDRY_ROOT}/marbles",
  modules: "{FOUNDRY_ROOT}/modules",
  processes: "{FOUNDRY_ROOT}/processes",
  skills: "{FOUNDRY_ROOT}/skills",
  spyglass: "{FOUNDRY_ROOT}/spyglass",
} as const;

export type FoundryPaths = {
  readonly [K in keyof typeof FOUNDRY_PATHS]: string;
};

const PLACEHOLDER = /(\{[^{}]*\})/;
const TRAILING_SEPARATORS = /[/\\]+$/;

function expand(
  template: string,
  roots: Readonly<Record<string, string>>,
  separator: string
): string {
  return template
    .split(PLACEHOLDER)
    .map((part, index) => {
      if (index % 2 === 0) {
        return part.replaceAll("/", separator);
      }
      const name = part.slice(1, -1);
      const root = roots[name];
      if (root === undefined) {
        throw new Error(`no root named ${name} for the path ${template}`);
      }
      return root.replace(TRAILING_SEPARATORS, "");
    })
    .join("");
}

export function resolvePathTemplates<T extends Record<string, string>>(
  templates: T,
  roots: Readonly<Record<string, string>>,
  separator = "/"
): { readonly [K in keyof T]: string } {
  return Object.fromEntries(
    Object.entries(templates).map(([key, template]) => [
      key,
      expand(template, roots, separator),
    ])
  ) as { readonly [K in keyof T]: string };
}

export function resolveFoundryPaths(
  foundryRoot: string,
  separator = "/"
): FoundryPaths {
  return resolvePathTemplates(
    FOUNDRY_PATHS,
    { FOUNDRY_ROOT: foundryRoot },
    separator
  );
}
