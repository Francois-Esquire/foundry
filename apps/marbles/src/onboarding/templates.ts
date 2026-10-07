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
/** What `marbles init` creates when no starter is named. */
export const DEFAULT_STARTER: StarterId = "product";
/** The harness a starter routes to; "auto" takes the first available one. */
const HARNESS_CHOICES = ["auto", "codex", "claude-code"] as const;
export type HarnessChoice = (typeof HARNESS_CHOICES)[number];
export const DEFAULT_HARNESS: HarnessChoice = "auto";
export interface SetupDraft {
  readonly harness: HarnessChoice;
  readonly instructions: string;
  readonly name: string;
  readonly template: StarterId;
}
const STEP_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
export function renderModule(draft: SetupDraft): string {
  const starter = STARTERS.find((item) => item.id === draft.template);
  if (!starter) {
    throw new Error("Choose a starter template.");
  }
  if (!STEP_NAME.test(draft.name)) {
    throw new Error(
      "Use a step name starting with a letter, followed by letters, numbers, hyphens, or underscores."
    );
  }
  if (!HARNESS_CHOICES.includes(draft.harness)) {
    throw new Error("Choose an available harness option.");
  }
  const options = {
    name: draft.name,
    ...(draft.instructions.trim()
      ? { instructions: draft.instructions.trim() }
      : {}),
    ...(draft.harness === "auto" ? {} : { provider: draft.harness }),
  };
  const properties = Object.entries(options)
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`)
    .join("\n");
  return `import { ${starter.factory} } from "@foundry/marbles/prebuilt";\n\n${starter.factory}({\n${properties}\n});\n`;
}
