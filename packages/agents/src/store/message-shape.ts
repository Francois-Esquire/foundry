/**
 * The structure a kept message's `parts` and `metadata` must have, checked
 * without Zod, field by field, as `@foundry/agents/schema` defines it: each
 * part's variant, the fields it requires and the type of every field it has,
 * and the type of each `metadata` field. Enum values inside a part are not
 * checked; a field the schema does not name is allowed, as JSON keeps it.
 *
 * `Sessions` checks every message it writes after putting it in its JSON
 * form, so no store is handed a message another store could not read back;
 * the SQLite store checks again before writing and when reading a row.
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

const number: Check = (value, at) =>
  typeof value === "number" ? undefined : fault(at, value, "a number");

const boolean: Check = (value, at) =>
  typeof value === "boolean" ? undefined : fault(at, value, "a boolean");

/** Any JSON value. */
const anything: Check = () => undefined;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(item: Check): Check {
  return (value, at) => {
    if (!Array.isArray(value)) {
      return fault(at, value, "an array");
    }
    for (const [index, element] of value.entries()) {
      const found = item(element, `${at}[${index}]`);
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
  return (value, at) => {
    if (!isObject(value)) {
      return fault(at, value, "an object");
    }
    return fieldsFault(value, at, fields);
  };
}

function fieldsFault(
  value: Record<string, unknown>,
  at: string,
  { optional = {}, required = {} }: Fields
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
}

const providerOptions = record(record(anything));

const harnessActivityEvent = object({
  optional: {
    actions: list(string),
    nativeId: string,
    parentId: string,
    summary: string,
  },
  required: {
    agentId: string,
    harness: string,
    id: string,
    kind: string,
    lifetime: string,
    revision: number,
    sessionId: string,
    status: string,
    title: string,
  },
});

const harnessToolEvent = object({
  optional: { activityId: string, reason: string },
  required: {
    agentId: string,
    harness: string,
    inputSummary: string,
    outcome: string,
    sessionId: string,
    toolCallId: string,
    toolName: string,
  },
});

const capability = object({ required: { kind: string } });

const provenance = object({
  optional: {
    agentGeneration: number,
    agentId: string,
    capability,
    nativeId: string,
    parentToolCallId: string,
    serverId: string,
    sessionId: string,
    skillName: string,
  },
  required: { effectLocation: string, invocationId: string, source: string },
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
    optional: { activityId: string, answerCount: number },
    required: {
      harness: string,
      outcome: string,
      questionCount: number,
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
      agentGeneration: number,
      agentId: string,
      approvalMode: string,
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
    optional: { reason: string, scope: string },
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

function part(value: unknown, at: string): ShapeFault | undefined {
  if (!isObject(value)) {
    return fault(at, value, "a part");
  }
  const { type } = value;
  const fields =
    typeof type === "string" && Object.hasOwn(PART_FIELDS, type)
      ? PART_FIELDS[type]
      : undefined;
  if (fields === undefined) {
    return {
      path: `${at}.type`,
      reason: `holds ${describe(type)}, which is no part type`,
    };
  }
  return fieldsFault(value, at, fields);
}

const METADATA = object({
  optional: {
    harnessEnvironment: object({ required: { harness: string, id: string } }),
    model: object({
      optional: { harness: string, provider: string },
      required: { id: string },
    }),
    notification: object({ required: { kind: string, taskId: string } }),
    output: anything,
    providerOptions,
    timing: object({
      required: { completedAt: number, durationMs: number, startedAt: number },
    }),
    usage: object({
      optional: {
        cachedInputTokens: number,
        cacheWriteTokens: number,
        reasoningTokens: number,
      },
      required: {
        inputTokens: number,
        outputTokens: number,
        totalTokens: number,
      },
    }),
  },
});
