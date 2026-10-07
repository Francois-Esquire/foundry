import { CLI_HARNESS_IDS, type CliHarness } from "~/lib/cli-harnesses";

/** How setup names each CLI harness. */
const HARNESS_LABELS: Record<CliHarness, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

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

/** The harness a starter routes to: a CLI harness, or "auto" for the first available one. */
export type HarnessChoice = "auto" | CliHarness;
export const DEFAULT_HARNESS: HarnessChoice = "auto";
/** Every choice, labelled, in the order setup offers them. */
export const HARNESS_CHOICES: readonly {
  readonly label: string;
  readonly value: HarnessChoice;
}[] = [
  { label: "First available", value: "auto" },
  ...CLI_HARNESS_IDS.map((id) => ({ label: HARNESS_LABELS[id], value: id })),
];

export function isHarnessChoice(value: unknown): value is HarnessChoice {
  return HARNESS_CHOICES.some((choice) => choice.value === value);
}

export function starterFor(id: StarterId): Starter {
  const starter = STARTERS.find((item) => item.id === id);
  if (!starter) {
    throw new Error("Choose a starter template.");
  }
  return starter;
}

export interface SetupDraft {
  readonly harness: HarnessChoice;
  readonly instructions: string;
  readonly name: string;
  readonly template: StarterId;
}

/** Setup's first draft: the default starter under its own name, on the default harness. */
export const DEFAULT_DRAFT: SetupDraft = {
  harness: DEFAULT_HARNESS,
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
  if (!isHarnessChoice(draft.harness)) {
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
