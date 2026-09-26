import type { Token } from "@p/store";

export function run(t: Token): string {
  return t.id;
}
