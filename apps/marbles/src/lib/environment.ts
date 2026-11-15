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

/**
 * What a workspace's commands inherit: the machine's environment, over the
 * workspace's own values, which fill only what the machine leaves unset.
 */
export function executionEnvironment(environment: {
  readonly machine: Readonly<Record<string, string>>;
  readonly workspace: Readonly<Record<string, string>>;
}): Record<string, string> {
  return { ...environment.workspace, ...environment.machine };
}
