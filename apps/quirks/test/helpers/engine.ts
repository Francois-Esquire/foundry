import { catalog } from "~/lib/catalog";
import type { EngineOptions } from "~/lib/engine";
import { Engine } from "~/lib/engine";

/**
 * A started engine over the authoring catalog. With no options it has no
 * managers wired, so a body that reaches for one is refused; pass the
 * managers, feed, or state dir a test needs.
 */
export function startEngine(
  options: Partial<EngineOptions> = {}
): Promise<Engine> {
  return new Engine({ catalog, root: process.cwd(), ...options }).start();
}
