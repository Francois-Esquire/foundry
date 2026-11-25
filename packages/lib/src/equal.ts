interface SeenPairs {
  readonly left: Map<object, object>;
  readonly right: Map<object, object>;
}

function ownEnumerableKeys(value: object): (string | symbol)[] {
  const symbols = Object.getOwnPropertySymbols(value).filter((symbol) =>
    Object.prototype.propertyIsEnumerable.call(value, symbol)
  );
  return [...Object.keys(value), ...symbols];
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

function equalTypedViews(a: ArrayBufferView, b: ArrayBufferView): boolean {
  return equalBytes(
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
    new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  );
}

function equalSets(a: Set<unknown>, b: Set<unknown>, seen: SeenPairs): boolean {
  if (a.size !== b.size) {
    return false;
  }
  const bItems = [...b];
  const matched = new Array<boolean>(bItems.length).fill(false);
  for (const itemA of a) {
    let found = false;
    for (let i = 0; i < bItems.length; i += 1) {
      if (!matched[i] && isEqual(itemA, bItems[i], seen)) {
        matched[i] = true;
        found = true;
        break;
      }
    }
    if (!found) {
      return false;
    }
  }
  return true;
}

function equalMaps(
  a: Map<unknown, unknown>,
  b: Map<unknown, unknown>,
  seen: SeenPairs
): boolean {
  if (a.size !== b.size) {
    return false;
  }
  const bEntries = [...b.entries()];
  const matched = new Array<boolean>(bEntries.length).fill(false);
  for (const [keyA, valueA] of a.entries()) {
    let found = false;
    for (let i = 0; i < bEntries.length; i += 1) {
      const entryB = bEntries[i];
      if (
        !matched[i] &&
        entryB !== undefined &&
        isEqual(keyA, entryB[0], seen) &&
        isEqual(valueA, entryB[1], seen)
      ) {
        matched[i] = true;
        found = true;
        break;
      }
    }
    if (!found) {
      return false;
    }
  }
  return true;
}

function equalArrays(
  a: readonly unknown[],
  b: readonly unknown[],
  seen: SeenPairs
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (i in a !== i in b) {
      return false;
    }
    if (!isEqual(a[i], b[i], seen)) {
      return false;
    }
  }
  return equalOwnProperties(a, b, seen);
}

function equalOwnProperties(a: object, b: object, seen: SeenPairs): boolean {
  const keysA = ownEnumerableKeys(a);
  const keysB = ownEnumerableKeys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  const keysBSet = new Set(keysB);
  const left = a as Record<string | symbol, unknown>;
  const right = b as Record<string | symbol, unknown>;
  for (const key of keysA) {
    if (!keysBSet.has(key)) {
      return false;
    }
    if (!isEqual(left[key], right[key], seen)) {
      return false;
    }
  }
  return true;
}

function equalBoxedPrimitive(a: object, b: object): boolean | null {
  if (a instanceof Number) {
    return b instanceof Number && Object.is(a.valueOf(), b.valueOf());
  }
  if (a instanceof String) {
    return b instanceof String && a.valueOf() === b.valueOf();
  }
  if (a instanceof Boolean) {
    return b instanceof Boolean && a.valueOf() === b.valueOf();
  }
  const tag = Object.prototype.toString.call(a);
  if (tag === "[object BigInt]" || tag === "[object Symbol]") {
    return (
      Object.prototype.toString.call(b) === tag &&
      Object.is(a.valueOf(), b.valueOf())
    );
  }
  return null;
}

function equalError(a: Error, b: Error, seen: SeenPairs): boolean {
  if (a.name !== b.name || a.message !== b.message) {
    return false;
  }
  const aHasCause = "cause" in a;
  const bHasCause = "cause" in b;
  if (aHasCause !== bHasCause) {
    return false;
  }
  return !aHasCause || isEqual(a.cause, b.cause, seen);
}

function equalBuiltinContent(a: object, b: object, seen: SeenPairs): boolean {
  if (a instanceof Date) {
    return b instanceof Date && Object.is(a.getTime(), b.getTime());
  }
  if (a instanceof RegExp) {
    return (
      b instanceof RegExp &&
      a.source === b.source &&
      a.flags === b.flags &&
      a.lastIndex === b.lastIndex
    );
  }
  if (a instanceof Error) {
    return b instanceof Error && equalError(a, b, seen);
  }
  if (a instanceof ArrayBuffer) {
    return (
      b instanceof ArrayBuffer &&
      equalBytes(new Uint8Array(a), new Uint8Array(b))
    );
  }
  if (ArrayBuffer.isView(a)) {
    return ArrayBuffer.isView(b) && equalTypedViews(a, b);
  }
  if (a instanceof Set) {
    return b instanceof Set && equalSets(a, b, seen);
  }
  if (a instanceof Map) {
    return b instanceof Map && equalMaps(a, b, seen);
  }
  const boxed = equalBoxedPrimitive(a, b);
  return boxed ?? true;
}

function isEqual(a: unknown, b: unknown, seen: SeenPairs): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return false;
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
    return false;
  }
  if (seen.left.has(a) || seen.right.has(b)) {
    return seen.left.get(a) === b && seen.right.get(b) === a;
  }
  seen.left.set(a, b);
  seen.right.set(b, a);
  try {
    if (Array.isArray(a)) {
      return Array.isArray(b) && equalArrays(a, b, seen);
    }
    return equalBuiltinContent(a, b, seen) && equalOwnProperties(a, b, seen);
  } finally {
    seen.left.delete(a);
    seen.right.delete(b);
  }
}

export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  return isEqual(a, b, { left: new Map(), right: new Map() });
}
