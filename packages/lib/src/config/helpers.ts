export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

export function getDeep(value: unknown, segments: string[]): unknown {
  let cur: unknown = value;
  for (const seg of segments) {
    if (!isPlainObject(cur)) {
      return undefined;
    }
    cur = cur[seg];
  }
  return cur;
}

export interface LeafChange {
  after: unknown;
  before: unknown;
  path: string;
}

export function* leafDiff(
  path: string,
  before: unknown,
  after: unknown
): Generator<LeafChange> {
  if (Object.is(before, after)) {
    return;
  }
  const beforeIsObj = isPlainObject(before);
  const afterIsObj = isPlainObject(after);
  if (beforeIsObj || afterIsObj) {
    const b = beforeIsObj ? before : ({} as Record<string, unknown>);
    const a = afterIsObj ? after : ({} as Record<string, unknown>);
    const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
    for (const key of keys) {
      const subPath = path ? `${path}.${key}` : key;
      yield* leafDiff(subPath, b[key], a[key]);
    }
    return;
  }
  yield { after, before, path };
}

export function setDeepPreserveUndefined(
  value: unknown,
  segments: string[],
  leaf: unknown
): unknown {
  if (segments.length === 0) {
    return leaf;
  }
  const base: Record<string, unknown> = isPlainObject(value)
    ? { ...value }
    : {};
  const [head, ...rest] = segments;
  if (!head) {
    return base;
  }
  base[head] =
    rest.length === 0 ? leaf : setDeepPreserveUndefined(base[head], rest, leaf);
  return base;
}

export function deepMergePreserveUndefined(
  base: unknown,
  patch: unknown
): unknown {
  if (!(isPlainObject(base) && isPlainObject(patch))) {
    return patch;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = deepMergePreserveUndefined(current, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function setDeepClearUndefined(
  base: unknown,
  segments: string[],
  leaf: unknown
): unknown {
  if (segments.length === 0) {
    return leaf;
  }
  const [head, ...rest] = segments;
  if (!head) {
    return base;
  }
  const obj: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  if (rest.length === 0) {
    if (leaf === undefined) {
      Reflect.deleteProperty(obj, head);
    } else {
      obj[head] = leaf;
    }
  } else {
    obj[head] = setDeepClearUndefined(obj[head], rest, leaf);
  }
  return obj;
}

export function deepMergeClearUndefined(
  base: unknown,
  patch: unknown
): unknown {
  if (!(isPlainObject(base) && isPlainObject(patch))) {
    return patch === undefined ? base : patch;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      Reflect.deleteProperty(out, key);
    } else if (isPlainObject(out[key]) && isPlainObject(value)) {
      out[key] = deepMergeClearUndefined(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
