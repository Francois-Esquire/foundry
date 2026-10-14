import type { Store } from "./index";

export function makeAdapter(store: Store): () => string | undefined {
  return () => store.get("default");
}
