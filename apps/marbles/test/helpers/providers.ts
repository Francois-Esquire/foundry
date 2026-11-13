import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The CLI providers a test machine is configured with, in preference order. */
const TEST_PROVIDERS = ["claude-code", "codex", "pi"] as const;

/** Write a machine provider configuration under the Marbles state root `state`. */
export function configureProviders(
  state: string,
  ids: readonly string[] = TEST_PROVIDERS
): void {
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "providers.json"),
    JSON.stringify({
      providers: ids.map((id) => ({ enabled: true, id, plugin: id })),
      version: 1,
    })
  );
}
