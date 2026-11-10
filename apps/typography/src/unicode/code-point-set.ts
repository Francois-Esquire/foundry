/**
 * A sorted set of code points as text. Each token is a run: the gap since the
 * previous run ended, then, after a dot, how many more code points the run
 * holds. Both numbers are base 36, so a to z is "2p.p".
 */

const RADIX = 36;

export const encodeCodePoints = (codePoints: Iterable<number>): string => {
  const sorted = [...new Set(codePoints)].sort((a, b) => a - b);
  const tokens: string[] = [];
  let next = 0;
  let index = 0;
  while (index < sorted.length) {
    const first = sorted[index] ?? 0;
    let last = first;
    index += 1;
    while (sorted[index] === last + 1) {
      last += 1;
      index += 1;
    }
    const gap = (first - next).toString(RADIX);
    tokens.push(
      last === first ? gap : `${gap}.${(last - first).toString(RADIX)}`
    );
    next = last + 1;
  }
  return tokens.join(",");
};

export const decodeCodePoints = (encoded: string): Uint32Array => {
  if (encoded === "") {
    return new Uint32Array(0);
  }
  const codePoints: number[] = [];
  let next = 0;
  for (const token of encoded.split(",")) {
    const [gap = "0", extra = "0"] = token.split(".");
    const first = next + Number.parseInt(gap, RADIX);
    const last = first + Number.parseInt(extra, RADIX);
    for (let codePoint = first; codePoint <= last; codePoint += 1) {
      codePoints.push(codePoint);
    }
    next = last + 1;
  }
  return Uint32Array.from(codePoints);
};
