/** Null when the bytes are not valid UTF-8 text, which is a binary result. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The errno alone — never the message, which carries the absolute path. */
export function errorCode(error: unknown): string {
  const code: unknown = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown";
}
