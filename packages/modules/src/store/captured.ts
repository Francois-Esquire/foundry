import type {
  InstallationListQuery,
  ManifestListQuery,
  ModuleListQuery,
  ModuleStoreWrite,
} from "../store";

/**
 * How every store takes a write or a list query from its caller: each
 * property the interface names is read once, by name, so a property that is
 * a getter on a prototype is read like any other, and nothing else on the
 * object is read. Every record a write puts must be plain data, and is
 * captured field by field into a new plain object, so both stores and their
 * transaction views start from the same capture and cannot keep a write
 * differently. A store then copies the capture (`structuredClone`) so that
 * nothing it keeps is shared with the caller.
 *
 * A capture refuses, with a `TypeError` naming the property, what neither
 * store could keep as the caller sees it: a list that is not an array, a
 * delete key that is not text, a record that is not plain data, and a field
 * of the wrong type. What only SQLite cannot keep (U+0000 in text, `-0`, an
 * invalid `Date`, a value JSON changes) is the SQLite store's own refusal.
 */

/** Every property of a write, each `true`, so a property added to the type must be added here. */
const WRITE_PROPERTIES = {
  deleteInstallations: true,
  deleteManifests: true,
  deleteModules: true,
  putInstallations: true,
  putManifests: true,
  putModules: true,
} as const satisfies Record<keyof ModuleStoreWrite, true>;

type Capture = (record: unknown, at: string) => unknown;

const CAPTURES: Record<keyof ModuleStoreWrite, Capture> = {
  deleteInstallations: key,
  deleteManifests: key,
  deleteModules: key,
  putInstallations: installation,
  putManifests: manifest,
  putModules: module,
};

/**
 * `write`'s properties, each read once, in a plain object that holds only
 * the ones that are not `undefined`, every record captured field by field.
 */
export function capturedWrite(write: ModuleStoreWrite): ModuleStoreWrite {
  const captured: Record<string, unknown> = {};
  for (const property of Object.keys(
    WRITE_PROPERTIES
  ) as (keyof ModuleStoreWrite)[]) {
    const value: unknown = Reflect.get(write, property);
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value)) {
      throw new TypeError(`${property} must be an array`);
    }
    const capture = CAPTURES[property];
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      // Each entry is read once; the capture holds what that read gave.
      items.push(capture(value[index], `${property}[${index}]`));
    }
    captured[property] = items;
  }
  return captured as ModuleStoreWrite;
}

type AnyListQuery = InstallationListQuery & ManifestListQuery & ModuleListQuery;

/** Every property of any list query, each `true`. */
const QUERY_PROPERTIES = {
  after: true,
  artifactId: true,
  limit: true,
  moduleId: true,
} as const satisfies Record<keyof AnyListQuery, true>;

/**
 * `query`'s properties, each read once, in a plain object; `undefined` ones
 * left out. Refuses, with a `TypeError`, an `artifactId` or `moduleId` that
 * is not text, which the stores would otherwise match differently. `limit`
 * and `after` are checked by the caller (`ownedQuery`).
 */
export function capturedQuery<Q extends object>(query: Q): Q {
  const captured: Record<string, unknown> = {};
  for (const property of Object.keys(QUERY_PROPERTIES)) {
    const value: unknown = Reflect.get(query, property);
    if (value === undefined) {
      continue;
    }
    if (
      (property === "artifactId" || property === "moduleId") &&
      typeof value !== "string"
    ) {
      throw new TypeError(`${property} must be text`);
    }
    captured[property] = value;
  }
  return captured as Q;
}

function key(value: unknown, at: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${at} must be text`);
  }
  return value;
}

function module(value: unknown, at: string) {
  const record = plain(value, at);
  return {
    artifactId: text(record, "artifactId", at),
    id: text(record, "id", at),
  };
}

function manifest(value: unknown, at: string) {
  const record = plain(value, at);
  return {
    contentId: text(record, "contentId", at),
    manifest: plainCopy(record.manifest, `${at}.manifest`),
    moduleId: text(record, "moduleId", at),
  };
}

function installation(value: unknown, at: string) {
  const record = plain(value, at);
  const fields = plain(record.installation, `${at}.installation`);
  const fieldAt = `${at}.installation`;
  const grants: unknown = record.grants;
  if (!Array.isArray(grants)) {
    throw new TypeError(`${at}.grants must be an array`);
  }
  const containerId: unknown = fields.containerId;
  if (containerId !== null && typeof containerId !== "string") {
    throw new TypeError(`${fieldAt}.containerId must be text or null`);
  }
  return {
    grants: Array.from({ length: grants.length }, (_, index) => {
      const grantAt = `${at}.grants[${index}]`;
      const grant = plain(grants[index], grantAt);
      return {
        capability: text(grant, "capability", grantAt),
        constraintsDigest: text(grant, "constraintsDigest", grantAt),
        createdAt: date(grant, "createdAt", grantAt),
        version: number(grant, "version", grantAt),
      };
    }),
    installation: {
      containerId,
      contentId: text(fields, "contentId", fieldAt),
      createdAt: date(fields, "createdAt", fieldAt),
      generation: number(fields, "generation", fieldAt),
      id: text(fields, "id", fieldAt),
      moduleId: text(fields, "moduleId", fieldAt),
      startAttempts: number(fields, "startAttempts", fieldAt),
      status: text(fields, "status", fieldAt),
      updatedAt: date(fields, "updatedAt", fieldAt),
    },
  };
}

function text(
  record: Readonly<Record<string, unknown>>,
  field: string,
  at: string
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new TypeError(`${at}.${field} must be text`);
  }
  return value;
}

function number(
  record: Readonly<Record<string, unknown>>,
  field: string,
  at: string
): number {
  const value = record[field];
  if (typeof value !== "number") {
    throw new TypeError(`${at}.${field} must be a number`);
  }
  return value;
}

function date(
  record: Readonly<Record<string, unknown>>,
  field: string,
  at: string
): Date {
  const value = record[field];
  if (!(value instanceof Date)) {
    throw new TypeError(`${at}.${field} must be a Date`);
  }
  return value;
}

/**
 * `value` as a record whose fields can be read, when it is plain data: an
 * object made by `{}` or `Object.create(null)` with every own property
 * enumerable and none keyed by a symbol. A copy of anything else could keep
 * less than the record shows, and differently in each store.
 */
function plain(value: unknown, at: string): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) {
    throw new TypeError(
      `${at} must be a plain object whose own properties are all enumerable`
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * A detached copy of a JSON document, made in one pass that reads each
 * property exactly once and validates what that read gave: every object
 * plain (see {@link plain}), every array a plain array without holes, every
 * other value a string, a number, a boolean or `null`, and no value inside
 * itself. A getter is therefore called once, and the copy holds what it
 * returned; nothing is read again later to copy it. Refuses anything else
 * with a `TypeError` naming the path.
 */
export function plainCopy(
  value: unknown,
  at: string,
  ancestors = new Set<object>()
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${at} must be JSON data, not ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${at} must not contain itself`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertyNames(value).length !== value.length + 1
      ) {
        throw new TypeError(`${at} must be a plain array without holes`);
      }
      const items: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        items.push(plainCopy(value[index], `${at}[${index}]`, ancestors));
      }
      return items;
    }
    const record = plain(value, at);
    const copy: Record<string, unknown> = {};
    for (const field of Object.keys(record)) {
      // One read per property: the copy keeps exactly what was checked.
      const item: unknown = Reflect.get(record, field);
      Object.defineProperty(copy, field, {
        configurable: true,
        enumerable: true,
        value: plainCopy(item, `${at}.${field}`, ancestors),
        writable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function isPlainObject(value: unknown): boolean {
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
