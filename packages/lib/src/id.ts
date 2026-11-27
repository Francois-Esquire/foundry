const HEX = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, "0")
);
const RANDOM_BYTES = 10;

export interface GenerateIdOptions {
  readonly now?: () => number;
  readonly prefix?: string;
  readonly random?: (bytes: Uint8Array) => Uint8Array;
}

function defaultRandom(bytes: Uint8Array): Uint8Array {
  return globalThis.crypto.getRandomValues(bytes);
}

export function generateId(options: GenerateIdOptions = {}): string {
  const timestamp = Math.max(0, Math.trunc((options.now ?? Date.now)()));
  const timeHex = timestamp.toString(16).padStart(12, "0");
  const bytes = (options.random ?? defaultRandom)(new Uint8Array(RANDOM_BYTES));
  let randomHex = "";
  for (const byte of bytes) {
    randomHex += HEX[byte] ?? "00";
  }
  const value = `${timeHex}${randomHex}`;
  return options.prefix ? `${options.prefix}_${value}` : value;
}
