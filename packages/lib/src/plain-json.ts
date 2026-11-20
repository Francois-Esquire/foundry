export function ownedEvents<E>(events: unknown): readonly E[] | undefined {
  if (events === undefined) {
    return;
  }
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }
  return plainJson("events", events) as E[];
}

export function plainJson(at: string, value: unknown): unknown {
  return copied(at, value, new Set());
}

function copied(at: string, value: unknown, ancestors: Set<object>): unknown {
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new TypeError(`${at} must be a finite number other than -0`);
      }
      return value;
    case "object":
      break;
    default:
      throw new TypeError(`${at} has no JSON form (${typeof value})`);
  }
  if (value === null) {
    return null;
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${at} contains itself`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return plainArray(at, value, ancestors);
    }
    if (!isPlainObject(value)) {
      throw new TypeError(
        `${at} must be a plain object whose own properties are all enumerable`
      );
    }
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: copied(`${at}.${key}`, Reflect.get(value, key), ancestors),
        writable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

export function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertyNames(value).length === Object.keys(value).length &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

function plainArray(
  at: string,
  value: readonly unknown[],
  ancestors: Set<object>
): unknown[] {
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new TypeError(`${at} must be a plain array holding only its entries`);
  }
  const copy = Array.from({ length: value.length }, (_, index) => {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${at}[${index}] is a hole in an array`);
    }
    return copied(`${at}[${index}]`, value[index], ancestors);
  });
  if (Object.getOwnPropertyNames(value).length !== copy.length + 1) {
    throw new TypeError(`${at} must be a plain array holding only its entries`);
  }
  return copy;
}

export function ownedWrite<W extends { readonly events?: readonly unknown[] }>(
  write: W
): W {
  const { events, ...rest } = write;
  const taken = ownedEvents(events);
  const copy = structuredClone(rest);
  return (taken === undefined ? copy : { ...copy, events: taken }) as W;
}
