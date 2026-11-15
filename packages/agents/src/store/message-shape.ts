/**
 * The structure a kept message's `parts` and `metadata` must have, checked
 * without Zod, field by field, as `@foundry/agents/schema` defines it: each
 * part's variant, each capability's variant, the fields each requires, the
 * type of every field, the values of every enum, the bounds of every count
 * and the length of every record id. A field the schema does not name is
 * allowed where the schema strips it, and refused inside a capability,
 * which the schema keeps strict. A test holds every check to the schema,
 * field by field and value by value.
 *
 * `Sessions` checks the parts and metadata a caller supplies, and the SQLite
 * store checks every message it writes and every row it reads.
 */

/** Where a value is wrong, below the field checked, and how. */
export interface ShapeFault {
  /** A path such as `parts[2].event.revision`. */
  readonly path: string;
  readonly reason: string;
}

type Check = (value: unknown, at: string) => ShapeFault | undefined;

interface Fields {
  readonly optional?: Readonly<Record<string, Check>>;
  readonly required?: Readonly<Record<string, Check>>;
  /** Refuse a field neither list names, as a strict schema does. */
  readonly strict?: boolean;
}

/** The first fault in a message's `parts`, or none. */
export function partsFault(parts: unknown): ShapeFault | undefined {
  return list(part)(parts, "parts");
}

/** The first fault in a message's `metadata`, or none. `undefined` is the field left out. */
export function metadataFault(metadata: unknown): ShapeFault | undefined {
  return metadata === undefined ? undefined : METADATA(metadata, "metadata");
}

function describe(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return String(value);
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  return "an object";
}

function fault(path: string, value: unknown, wanted: string): ShapeFault {
  return { path, reason: `holds ${describe(value)}, not ${wanted}` };
}

const string: Check = (value, at) =>
  typeof value === "string" ? undefined : fault(at, value, "a string");

/** A record id: a nonempty string. */
const recordId: Check = (value, at) =>
  typeof value === "string" && value.length > 0
    ? undefined
    : fault(at, value, "a nonempty string");

const boolean: Check = (value, at) =>
  typeof value === "boolean" ? undefined : fault(at, value, "a boolean");

/** A safe integer at least `least`, or any safe integer. */
function integer(least?: number): Check {
  const wanted =
    least === undefined
      ? "an integer"
      : `an integer of at least ${String(least)}`;
  return (value, at) =>
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    (least === undefined || value >= least)
      ? undefined
      : fault(at, value, wanted);
}

/** A token or item count, or epoch milliseconds. */
const count = integer(0);

/** Any JSON value. */
const anything: Check = () => undefined;

function oneOf(values: readonly string[]): Check {
  return (value, at) =>
    typeof value === "string" && values.includes(value)
      ? undefined
      : fault(at, value, `one of ${values.join(", ")}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(item: Check): Check {
  return (value, at) => {
    if (!Array.isArray(value)) {
      return fault(at, value, "an array");
    }
    for (let index = 0; index < value.length; index += 1) {
      const found = item(value[index], `${at}[${index}]`);
      if (found !== undefined) {
        return found;
      }
    }
  };
}

function record(item: Check): Check {
  return (value, at) => {
    if (!isObject(value)) {
      return fault(at, value, "an object");
    }
    for (const [key, element] of Object.entries(value)) {
      const found = item(element, `${at}[${JSON.stringify(key)}]`);
      if (found !== undefined) {
        return found;
      }
    }
  };
}

function object(fields: Fields): Check {
  return (value, at) =>
    isObject(value)
      ? fieldsFault(value, at, fields, [])
      : fault(at, value, "an object");
}

/**
 * An object whose `discriminator` names its variant in `variants`; `what`
 * names the discriminator's values in a refusal.
 */
function variant(
  discriminator: string,
  variants: Readonly<Record<string, Fields>>,
  what: string,
  wanted: string
): Check {
  return (value, at) => {
    if (!isObject(value)) {
      return fault(at, value, wanted);
    }
    const tag = value[discriminator];
    const fields =
      typeof tag === "string" && Object.hasOwn(variants, tag)
        ? variants[tag]
        : undefined;
    if (fields === undefined) {
      return {
        path: `${at}.${discriminator}`,
        reason: `holds ${describe(tag)}, which is no ${what}`,
      };
    }
    return fieldsFault(value, at, fields, [discriminator]);
  };
}

function fieldsFault(
  value: Record<string, unknown>,
  at: string,
  { optional = {}, required = {}, strict = false }: Fields,
  known: readonly string[]
): ShapeFault | undefined {
  for (const [key, check] of Object.entries(required)) {
    if (!Object.hasOwn(value, key)) {
      return { path: `${at}.${key}`, reason: "is missing" };
    }
    const found = check(value[key], `${at}.${key}`);
    if (found !== undefined) {
      return found;
    }
  }
  for (const [key, check] of Object.entries(optional)) {
    if (Object.hasOwn(value, key)) {
      const found = check(value[key], `${at}.${key}`);
      if (found !== undefined) {
        return found;
      }
    }
  }
  if (strict) {
    const extra = Object.keys(value).find(
      (key) =>
        !(
          known.includes(key) ||
          Object.hasOwn(required, key) ||
          Object.hasOwn(optional, key)
        )
    );
    if (extra !== undefined) {
      return { path: `${at}.${extra}`, reason: "is no field of it" };
    }
  }
}

const providerOptions = record(record(anything));

const TOOL_SOURCES = [
  "declared",
  "builtin",
  "skill",
  "mcp",
  "mesh",
  "module",
  "harness",
] as const;

/** Each capability variant's fields, `kind` aside; the schema keeps each strict. */
const CAPABILITY_FIELDS: Readonly<Record<string, Fields>> = {
  "domain.command": {
    required: {
      command: object({
        required: { id: string, version: count },
        strict: true,
      }),
      domain: string,
      effect: oneOf(["read", "compute", "write"]),
      target: object({
        required: { projectId: string, scope: string },
        strict: true,
      }),
    },
    strict: true,
  },
  "fs.read": { required: { projectId: string, root: string }, strict: true },
  "mcp.tool": { required: { serverId: string, tool: string }, strict: true },
  "tool.call": {
    required: { source: oneOf(TOOL_SOURCES), tool: string },
    strict: true,
  },
  "web.fetch": { required: { domain: string }, strict: true },
};

const capability = variant(
  "kind",
  CAPABILITY_FIELDS,
  "capability kind",
  "a capability"
);

const harnessActivityEvent = object({
  optional: {
    actions: list(oneOf(["stop"])),
    nativeId: string,
    parentId: string,
    summary: string,
  },
  required: {
    agentId: string,
    harness: string,
    id: recordId,
    kind: oneOf(["subagent", "task", "watch", "schedule"]),
    lifetime: oneOf(["session", "sandbox"]),
    revision: integer(1),
    sessionId: recordId,
    status: oneOf([
      "running",
      "waiting",
      "complete",
      "failed",
      "cancelled",
      "unknown",
    ]),
    title: string,
  },
});

const harnessToolEvent = object({
  optional: { activityId: string, reason: string },
  required: {
    agentId: string,
    harness: string,
    inputSummary: string,
    outcome: oneOf(["started", "ran", "refused", "failed"]),
    sessionId: recordId,
    toolCallId: string,
    toolName: string,
  },
});

const provenance = object({
  optional: {
    agentGeneration: count,
    agentId: string,
    capability,
    nativeId: string,
    parentToolCallId: string,
    serverId: string,
    sessionId: recordId,
    skillName: string,
  },
  required: {
    effectLocation: oneOf(["runtime", "host", "executor"]),
    invocationId: string,
    source: oneOf([...TOOL_SOURCES, "external"]),
  },
});

/**
 * Each part variant's fields, `type` aside. A field the schema types
 * `unknown` (a tool's input or output) may be left out, as JSON leaves
 * out `undefined`.
 */
const PART_FIELDS: Readonly<Record<string, Fields>> = {
  error: { required: { message: string } },
  harness_activity: { required: { event: harnessActivityEvent } },
  harness_question: {
    optional: { activityId: string, answerCount: count },
    required: {
      harness: string,
      outcome: oneOf(["requested", "answered", "declined", "interrupted"]),
      questionCount: count,
      toolCallId: string,
    },
  },
  harness_session: { required: { harness: string, nativeSessionId: string } },
  harness_tool: { required: { event: harnessToolEvent } },
  image: { optional: { mediaType: string }, required: { url: string } },
  reasoning: { required: { text: string } },
  text: { required: { text: string } },
  tool_approval_request: {
    optional: {
      activityId: string,
      agentGeneration: count,
      agentId: string,
      approvalMode: oneOf(["live", "deferred"]),
      input: anything,
      signature: string,
    },
    required: {
      approvalId: string,
      capability,
      name: string,
      toolCallId: string,
    },
  },
  tool_approval_response: {
    optional: { reason: string, scope: oneOf(["once", "always"]) },
    required: { approvalId: string, approved: boolean },
  },
  tool_call: {
    optional: { input: anything, provenance, providerOptions },
    required: { name: string, toolCallId: string },
  },
  tool_result: {
    optional: { isError: boolean, output: anything },
    required: { toolCallId: string },
  },
};

const part = variant("type", PART_FIELDS, "part type", "a part");

const METADATA_FIELDS: Fields = {
  optional: {
    harnessEnvironment: object({ required: { harness: string, id: string } }),
    model: object({
      optional: { harness: string, provider: string },
      required: { id: string },
    }),
    notification: object({
      required: { kind: oneOf(["status", "completion"]), taskId: string },
    }),
    output: anything,
    providerOptions,
    timing: object({
      required: { completedAt: count, durationMs: integer(), startedAt: count },
    }),
    usage: object({
      optional: {
        cachedInputTokens: count,
        cacheWriteTokens: count,
        reasoningTokens: count,
      },
      required: { inputTokens: count, outputTokens: count, totalTokens: count },
    }),
  },
};

const METADATA = object(METADATA_FIELDS);

interface FieldNames {
  readonly optional: readonly string[];
  readonly required: readonly string[];
}

/**
 * The field names each check knows, required and optional, by part type,
 * by capability kind and for `metadata`, so a test can hold them to
 * `@foundry/agents/schema`.
 */
export function shapeFieldNames(): {
  readonly capabilities: Readonly<Record<string, FieldNames>>;
  readonly metadata: FieldNames;
  readonly parts: Readonly<Record<string, FieldNames>>;
} {
  const byVariant = (variants: Readonly<Record<string, Fields>>) =>
    Object.fromEntries(
      Object.entries(variants).map(([name, fields]) => [
        name,
        fieldNames(fields),
      ])
    );
  return {
    capabilities: byVariant(CAPABILITY_FIELDS),
    metadata: fieldNames(METADATA_FIELDS),
    parts: byVariant(PART_FIELDS),
  };
}

function fieldNames({ optional = {}, required = {} }: Fields): FieldNames {
  return {
    optional: Object.keys(optional).sort(),
    required: Object.keys(required).sort(),
  };
}
