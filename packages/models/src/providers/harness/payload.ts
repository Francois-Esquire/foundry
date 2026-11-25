import type { SessionInput } from "@foundry/core/agents";

export function inputText(input: SessionInput): string {
  if (typeof input === "string") {
    return input;
  }
  return input.parts
    .map((part) => {
      if (part.type !== "text") {
        throw new Error(
          "CLI harness input currently supports text parts only."
        );
      }
      return part.text;
    })
    .join("\n");
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}
