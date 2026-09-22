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
type StarterId = (typeof STARTERS)[number]["id"];
export interface SetupDraft {
  readonly harness: "auto" | "codex" | "claude-code";
  readonly instructions: string;
  readonly name: string;
  readonly template: StarterId;
}
const STEP_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
export function renderConfig(draft: SetupDraft): string {
  const starter = STARTERS.find((item) => item.id === draft.template);
  if (!starter) {
    throw new Error("Choose a starter template.");
  }
  if (!STEP_NAME.test(draft.name)) {
    throw new Error(
      "Use a step name starting with a letter, followed by letters, numbers, hyphens, or underscores."
    );
  }
  if (!["auto", "codex", "claude-code"].includes(draft.harness)) {
    throw new Error("Choose an available harness option.");
  }
  const options = {
    name: draft.name,
    ...(draft.instructions.trim()
      ? { instructions: draft.instructions.trim() }
      : {}),
    ...(draft.harness === "auto" ? {} : { harness: draft.harness }),
  };
  const properties = Object.entries(options)
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`)
    .join("\n");
  return `import { ${starter.factory} } from "@foundry/quirks/prebuilt";\n\n${starter.factory}({\n${properties}\n});\n`;
}
