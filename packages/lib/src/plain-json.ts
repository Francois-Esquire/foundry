/**
 * The one rule a store takes a write's change events by: each event is read
 * once, now, into an owned copy as plain JSON, since it reaches a host as
 * JSON. Every package store that carries events takes them through
 * {@link ownedEvents}, so they all refuse the same values the same way.
 */

/**
 * `events` as the store's own copy, or `undefined` when the write carries
 * none. Refuses, with a `TypeError` naming the first part, anything that is
 * not an array of plain JSON (see {@link plainJson}).
 */
export function ownedEvents<E>(events: unknown): readonly E[] | undefined {
  if (events === undefined) {
    return;
  }
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }
  return plainJson("events", events) as E[];
}

/**
 * An owned copy of `value` as plain JSON, each property read once, or a
 * `TypeError` naming the first part (`at` names `value` itself) that has no
 * JSON form that reads back the same: anything but a plain object (made by
 * `{}` or `Object.create(null)`, every own property enumerable, no
 * symbols), a plain array (made by `[]`, no hole, no own property but its
 * items and `length`), text, a finite number other than -0, a boolean or
 * `null`. So a Date, a class instance, `NaN`, a bigint, `undefined`, a
 * function, or a property a copy would not see refuses it.
 */
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
      // Defined, not assigned, so a `__proto__` key stays an own property.
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

/**
 * Whether `value` is an object made by `{}` or `Object.create(null)`, every
 * own property enumerable and none keyed by a symbol.
 */
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

/**
 * An owned copy of a plain array: made by `[]` or `Array` (no subclass), its
 * own properties its entries and `length` alone, every entry present. Any
 * other property, symbol-keyed or not, has no JSON form and refuses it.
 */
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
  // Every entry is present, so any own property past them and `length` is
  // one a copy of the entries would drop.
  if (Object.getOwnPropertyNames(value).length !== copy.length + 1) {
    throw new TypeError(`${at} must be a plain array holding only its entries`);
  }
  return copy;
}

/**
 * `write` as a store's own copy: its events taken by {@link ownedEvents},
 * first, and the rest by one `structuredClone`. Throws what either refuses.
 */
export function ownedWrite<W extends { readonly events?: readonly unknown[] }>(
  write: W
): W {
  const { events, ...rest } = write;
  const taken = ownedEvents(events);
  const copy = structuredClone(rest);
  return (taken === undefined ? copy : { ...copy, events: taken }) as W;
}
