export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseJsonRecord(
  source: string | undefined
): Record<string, unknown> | null {
  if (source === undefined) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(source);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
