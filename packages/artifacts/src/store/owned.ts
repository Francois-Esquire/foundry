import type { ArtifactEvent, ArtifactRecords, Blob } from "../schema";
import type { ArtifactStoreWrite } from "./index";

/**
 * A store's own copy of `write`, taken now: a `structuredClone` of the
 * whole write, then each blob's inline bytes copied again into a fresh
 * buffer of their own. `structuredClone` keeps a `SharedArrayBuffer`'s
 * memory shared (as Node does), so without that second copy a caller
 * changing the bytes after `commit`, or a reader changing bytes a store
 * handed out, would change what the store holds. Inline bytes are the one
 * place the record schema admits a byte buffer; metadata is plain JSON.
 *
 * Throws what the clone throws, for a write holding a value it refuses, and
 * a `TypeError` for events that are not plain JSON (see `ownedEvents`).
 */
export function ownedWrite(write: ArtifactStoreWrite): ArtifactStoreWrite {
  // `events` read once, and taken as the plain JSON a host is handed,
  // before the clone, which would turn a class instance into a plain object.
  const { events, ...records } = write;
  const owned = events === undefined ? undefined : ownedEvents(events);
  const copy = structuredClone(records);
  return {
    ...(copy.putBlobs === undefined
      ? copy
      : { ...copy, putBlobs: copy.putBlobs.map(ownedBlob) }),
    ...(owned === undefined ? {} : { events: owned }),
  };
}

/**
 * The write's events as an owned list of plain JSON, or a `TypeError` naming
 * the first part that has no JSON form reading back the same: anything but
 * a plain object (made by `{}` or `Object.create(null)`, every own property
 * enumerable, no symbols), an array without holes, text, a finite number
 * other than -0, a boolean or `null`. A Date, a class instance, `NaN`, a
 * bigint, `undefined` or a function refuses the whole write.
 */
function ownedEvents(events: unknown): ArtifactEvent[] {
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }
  return plainJson("events", events, new Set()) as ArtifactEvent[];
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
      return plainArray(at, value, ancestors);
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertyNames(value).length !== Object.keys(value).length ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
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

/** {@link ownedWrite} for a store's starting records. */
export function ownedRecords(records: ArtifactRecords): ArtifactRecords {
  const copy = structuredClone(records);
  return { ...copy, blobs: copy.blobs.map(ownedBlob) };
}

/** `blob` with its inline bytes, if any, in memory no one else holds. */
function ownedBlob(blob: Blob): Blob {
  return blob.bytes === undefined
    ? blob
    : { ...blob, bytes: new Uint8Array(blob.bytes) };
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
    return plainJson(`${at}[${index}]`, value[index], ancestors);
  });
  // Every entry is present, so any own property past them and `length` is
  // one a copy of the entries would drop.
  if (Object.getOwnPropertyNames(value).length !== copy.length + 1) {
    throw new TypeError(`${at} must be a plain array holding only its entries`);
  }
  return copy;
}
