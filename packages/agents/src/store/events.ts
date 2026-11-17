export function ownedEvents<E>(events: unknown): readonly E[] | undefined {
  if (events === undefined) {
    return;
  }
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }
  return plainJson("events", events, new Set()) as E[];
}

function plainJson(
  at: string,
  value: unknown,
  ancestors: Set<object>
): unknown {
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
      if (!isPlainArray(value)) {
        throw new TypeError(
          `${at} must be an array whose own properties are only its items and length`
        );
      }
      return Array.from({ length: value.length }, (_, index) => {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${at}[${index}] is a hole in an array`);
        }
        return plainJson(`${at}[${index}]`, value[index], ancestors);
      });
    }
    if (!isPlainData(value)) {
      throw new TypeError(
        `${at} must be a plain object whose own properties are all enumerable`
      );
    }
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: plainJson(`${at}.${key}`, Reflect.get(value, key), ancestors),
        writable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function isPlainArray(value: readonly unknown[]): boolean {
  return (
    Object.getPrototypeOf(value) === Array.prototype &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.getOwnPropertyNames(value).every(
      (key) => key === "length" || isIndex(key, value.length)
    )
  );
}

function isIndex(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function isPlainData(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertyNames(value).length === Object.keys(value).length &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}
