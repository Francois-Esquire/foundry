/**
 * The one rule every store here takes a write's events by: each event is
 * read once, now, into an owned copy as plain JSON, since it reaches a host
 * as JSON. The rule and its refusals are the ones the workflows and
 * artifacts stores take events by.
 */

/**
 * `events` as the store's own copy, or `undefined` when the write carries
 * none. Refuses, with a `TypeError` naming the first part, anything that is
 * not an array of plain JSON (see {@link plainJson}).
 */
function ownedEvents<E>(events: unknown): readonly E[] | undefined {
  if (events === undefined) {
    return;
  }
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }
  return plainJson("events", events, new Set()) as E[];
}

/**
 * An owned copy of `value` as plain JSON, each property read once, or a
 * `TypeError` naming the first part that has no JSON form that reads back
 * the same: anything but a plain object (made by `{}` or
 * `Object.create(null)`, every own property enumerable, no symbols), an
 * array without holes, text, a finite number other than -0, a boolean or
 * `null`. So a Date, a class instance, `NaN`, a bigint, `undefined`, a
 * function, or a property a copy would not see refuses the write.
 */
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
      // Defined, not assigned, so a `__proto__` key stays an own property.
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

function isPlainData(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertyNames(value).length === Object.keys(value).length &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

/**
 * `write` as the store's own copy: its events taken by {@link ownedEvents},
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
