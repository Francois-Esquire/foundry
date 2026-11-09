export const STARTERS = [
  {
    description: "Read-only code review",
    factory: "codeReview",
    id: "developer",
    label: "Developer",
    name: "code-review",
  },
  {
    description: "HTML/CSS prototype from a brief",
    factory: "prototype",
    id: "design",
    label: "Design",
    name: "prototype",
  },
  {
    description: "Summarize this codebase",
    factory: "summarizeCodebase",
    id: "product",
    label: "Product",
    name: "summarize-codebase",
  },
] as const;
export type StarterId = (typeof STARTERS)[number]["id"];
type Starter = (typeof STARTERS)[number];
/** What `marbles init` creates when no starter is named. */
export const DEFAULT_STARTER: StarterId = "product";

export function starterFor(id: StarterId): Starter {
  const starter = STARTERS.find((item) => item.id === id);
  if (!starter) {
    throw new Error("Choose a starter template.");
  }
  return starter;
}

/** A starter's settings. It names no provider, so new sessions follow the configured order. */
export interface SetupDraft {
  readonly instructions: string;
  readonly name: string;
  readonly template: StarterId;
}

export const DEFAULT_DRAFT: SetupDraft = {
  instructions: "",
  name: starterFor(DEFAULT_STARTER).name,
  template: DEFAULT_STARTER,
};
const STEP_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
export function renderModule(draft: SetupDraft): string {
  const starter = starterFor(draft.template);
  if (!STEP_NAME.test(draft.name)) {
    throw new Error(
      "Use a step name starting with a letter, followed by letters, numbers, hyphens, or underscores."
    );
  }
  const options = {
    name: draft.name,
    ...(draft.instructions.trim()
      ? { instructions: draft.instructions.trim() }
      : {}),
  };
  const properties = Object.entries(options)
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`)
    .join("\n");
  return `import { ${starter.factory} } from "@foundry.sh/marbles/prebuilt";\n\n${starter.factory}({\n${properties}\n});\n`;
}
