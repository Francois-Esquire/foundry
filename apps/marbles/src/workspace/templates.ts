export const STARTER = {
  description: "An agent introduces this repository",
  id: "starter",
  label: "Starter",
  name: "hello",
} as const;

export const STARTER_GUIDE =
  "https://francois-esquire.github.io/foundry/marbles/get-started/quickstart/";

export interface SetupDraft {
  readonly instructions: string;
  readonly name: string;
  readonly template: typeof STARTER.id;
}

export const DEFAULT_DRAFT: SetupDraft = {
  instructions: "",
  name: STARTER.name,
  template: STARTER.id,
};
const STEP_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const IDENTIFIER_PART = /[-_]+([a-zA-Z0-9])/g;
const RESERVED_JS_IDENTIFIERS = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const STARTER_IMPORTS = new Set(["agent", "step", "greeter"]);
const STARTER_PROMPT =
  "You are a teammate working in this repository. Read before you answer and do not edit files.";
const STARTER_TASK =
  "Read the README and introduce this repository in a few sentences: what it is for and where to start reading.";

function exportIdentifier(name: string): string {
  const camel = name
    .replace(IDENTIFIER_PART, (_, char: string) => char.toUpperCase())
    .replaceAll("-", "")
    .replaceAll("_", "");
  return STARTER_IMPORTS.has(camel) || RESERVED_JS_IDENTIFIERS.has(camel)
    ? `${camel}Step`
    : camel;
}

export function renderModule(draft: SetupDraft): string {
  if (!STEP_NAME.test(draft.name)) {
    throw new Error(
      "Use a step name starting with a letter, followed by letters, numbers, hyphens, or underscores."
    );
  }
  const prompt = [STARTER_PROMPT, draft.instructions.trim()]
    .filter(Boolean)
    .join("\n");
  return [
    'import { agent, step } from "@foundry.sh/marbles";',
    "",
    "const greeter = agent({",
    `  name: ${JSON.stringify(draft.name)},`,
    `  prompt: ${JSON.stringify(prompt)},`,
    "});",
    "",
    `export const ${exportIdentifier(draft.name)} = step(${JSON.stringify(draft.name)})`,
    `  .describe(${JSON.stringify(STARTER.description)})`,
    "  .do(async ({ agents }) => {",
    "    const session = await agents.session(greeter);",
    `    const reply = await session.generate(${JSON.stringify(STARTER_TASK)});`,
    "    return reply.text;",
    "  });",
    "",
  ].join("\n");
}
