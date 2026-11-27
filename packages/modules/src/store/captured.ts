import type { PageInput } from "@foundry/core/pagination";
import { pageLimit } from "@foundry/lib/pagination";
import { isPlainObject } from "@foundry/lib/plain-json";
import type {
  InstallationIdPageQuery,
  InstallationListQuery,
  ManifestListQuery,
  ModuleIdPageQuery,
  ModuleListQuery,
  ModuleStorePageQuery,
  ModuleStoreWrite,
} from "./index";

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
      items.push(capture(value[index], `${property}[${index}]`));
    }
    captured[property] = items;
  }
  return captured as ModuleStoreWrite;
}

type AnyListQuery = InstallationIdPageQuery &
  InstallationListQuery &
  ManifestListQuery &
  ModuleIdPageQuery &
  ModuleListQuery;

const QUERY_PROPERTIES = {
  after: true,
  artifactId: true,
  cursor: true,
  limit: true,
  moduleId: true,
} as const satisfies Record<keyof AnyListQuery, true>;

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
  const containerId: unknown = fields.containerId;
  if (containerId !== null && typeof containerId !== "string") {
    throw new TypeError(`${fieldAt}.containerId must be text or null`);
  }
  return {
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

function plain(value: unknown, at: string): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) {
    throw new TypeError(
      `${at} must be a plain object whose own properties are all enumerable`
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

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

export function ownedQuery<Q extends ModuleStorePageQuery>(query: Q): Q {
  const owned = structuredClone(query);
  if (!(Number.isSafeInteger(owned.limit) && owned.limit > 0)) {
    throw new RangeError(
      `limit must be a positive safe integer; got ${String(owned.limit)}`
    );
  }
  if (owned.after !== undefined && !Number.isSafeInteger(owned.after)) {
    throw new RangeError(
      `after must be a cursor a page returned; got ${String(owned.after)}`
    );
  }
  return owned;
}

export function ownedIdPageQuery<Q extends PageInput<string>>(
  query: Q
): Q & { readonly limit: number } {
  const owned = structuredClone(query);
  if (owned.cursor !== undefined && typeof owned.cursor !== "string") {
    throw new RangeError("Page cursor is invalid");
  }
  return {
    ...owned,
    limit: pageLimit(owned.limit),
  };
}
