/** Deterministic authoring failure with the owning definition and local path. */
export class DefinitionAuthoringError extends Error {
  readonly code:
    | "invalid-definition-key"
    | "invalid-node-key"
    | "duplicate-node-key"
    | "definition-cycle"
    | "invalid-composition"
    | "missing-output"
    | "duplicate-output";
  readonly definitionKey: string;
  readonly path: readonly string[];

  constructor(
    code:
      | "invalid-definition-key"
      | "invalid-node-key"
      | "duplicate-node-key"
      | "definition-cycle"
      | "invalid-composition"
      | "missing-output"
      | "duplicate-output",
    definitionKey: string,
    path: readonly string[],
    message: string
  ) {
    super(
      `[definition:${code}] ${definitionKey} at ${path.join(".") || "<root>"}: ${message}`
    );
    this.code = code;
    this.definitionKey = definitionKey;
    this.path = path;
    this.name = "DefinitionAuthoringError";
  }
}

export function requireDefinitionKey(value: unknown): string {
  if (typeof value === "string" && value.trim() === value && value.length > 0) {
    return value;
  }
  throw new DefinitionAuthoringError(
    "invalid-definition-key",
    typeof value === "string" ? value : "<unknown>",
    [],
    "definitionKey must be a non-empty, trimmed string"
  );
}

export function requireNodeKey(owner: string, value: unknown): string {
  if (typeof value === "string" && value.trim() === value && value.length > 0) {
    return value;
  }
  throw new DefinitionAuthoringError(
    "invalid-node-key",
    owner,
    [],
    "nodeKey must be a non-empty, trimmed string"
  );
}
