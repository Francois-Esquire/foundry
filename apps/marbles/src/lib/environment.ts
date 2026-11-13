/** The string-valued entries of an environment, copied. */
export function environmentSnapshot(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) {
      snapshot[name] = value;
    }
  }
  return snapshot;
}
