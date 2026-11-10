/**
 * Character names as text, one record per named character in code point
 * order, separated by semicolons. A record is the gap from the previous code
 * point in base 36 (left out when it is 1), a comma, one base 36 digit for
 * how many leading letters the name shares with the previous name, and the
 * rest of the name.
 */

const RADIX = 36;
const MAX_SHARED = RADIX - 1;

const sharedPrefixLength = (a: string, b: string) => {
  const limit = Math.min(a.length, b.length, MAX_SHARED);
  let length = 0;
  while (length < limit && a[length] === b[length]) {
    length += 1;
  }
  return length;
};

/** Entries must be in ascending code point order. */
export const encodeNames = (
  entries: readonly (readonly [codePoint: number, name: string])[]
): string => {
  const records: string[] = [];
  let previousCodePoint = -1;
  let previousName = "";
  for (const [codePoint, name] of entries) {
    const gap = codePoint - previousCodePoint;
    const shared = sharedPrefixLength(previousName, name);
    records.push(
      `${gap === 1 ? "" : gap.toString(RADIX)},${shared.toString(RADIX)}${name.slice(shared)}`
    );
    previousCodePoint = codePoint;
    previousName = name;
  }
  return records.join(";");
};

export const decodeNames = (encoded: string): Map<number, string> => {
  const names = new Map<number, string>();
  if (encoded === "") {
    return names;
  }
  let codePoint = -1;
  let previousName = "";
  for (const record of encoded.split(";")) {
    const comma = record.indexOf(",");
    const gap =
      comma === 0 ? 1 : Number.parseInt(record.slice(0, comma), RADIX);
    const shared = Number.parseInt(record.charAt(comma + 1), RADIX);
    const name = previousName.slice(0, shared) + record.slice(comma + 2);
    codePoint += gap;
    names.set(codePoint, name);
    previousName = name;
  }
  return names;
};
