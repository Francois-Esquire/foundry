import type { ArtifactEvent, ArtifactRecords, Blob } from "../schema";
import type { ArtifactStoreWrite } from "./index";

export function ownedWrite(write: ArtifactStoreWrite): ArtifactStoreWrite {
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

export function ownedRecords(records: ArtifactRecords): ArtifactRecords {
  const copy = structuredClone(records);
  return { ...copy, blobs: copy.blobs.map(ownedBlob) };
}

function ownedBlob(blob: Blob): Blob {
  return blob.bytes === undefined
    ? blob
    : { ...blob, bytes: new Uint8Array(blob.bytes) };
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
    return plainJson(`${at}[${index}]`, value[index], ancestors);
  });
  if (Object.getOwnPropertyNames(value).length !== copy.length + 1) {
    throw new TypeError(`${at} must be a plain array holding only its entries`);
  }
  return copy;
}
