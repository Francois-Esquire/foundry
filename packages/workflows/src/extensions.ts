export type ExtensionValue =
  | null
  | boolean
  | number
  | string
  | readonly ExtensionValue[]
  | { readonly [key: string]: ExtensionValue };

/** Host-owned JSON-safe data keyed by namespace. `workflows.*` is reserved. */
export type Extensions = Readonly<Record<string, ExtensionValue>>;

export function createExtensions(value: unknown = {}): Extensions {
  if (!isExtensions(value)) {
    throw new Error("extensions must contain only JSON-safe values");
  }
  for (const key of Object.keys(value)) {
    if (key.startsWith("workflows.")) {
      throw new Error(`extension namespace is reserved: ${key}`);
    }
  }
  return structuredClone(value);
}

export function mergeExtensions(
  existing: Extensions,
  patch: unknown
): Extensions {
  return createExtensions({ ...existing, ...createExtensions(patch) });
}

/** Decode untrusted persisted data without allowing malformed values into state. */
export function extensionsFromUnknown(value: unknown): Extensions {
  try {
    return createExtensions(value);
  } catch {
    return {};
  }
}

function isExtensions(value: unknown): value is Extensions {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) =>
      isExtensionValue(entry, new WeakSet())
    )
  );
}

function isExtensionValue(
  value: unknown,
  ancestors: WeakSet<object>
): value is ExtensionValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (!(Array.isArray(value) || isRecord(value))) {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  const valid = Object.values(value).every((entry) =>
    isExtensionValue(entry, ancestors)
  );
  ancestors.delete(value);
  return valid;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
