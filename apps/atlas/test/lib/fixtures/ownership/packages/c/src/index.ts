import type { Store } from "@w/a";

export function serve(store: Store): number {
  return store.size();
}

export function report(store: Store): string {
  return String(store.size());
}
