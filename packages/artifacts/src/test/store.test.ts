import { InMemoryArtifactStore } from "../store/memory";
import { describeArtifactManager } from "../testing/manager";
import { describeArtifactStore } from "../testing/store";

/** Fresh storage: one store per scope, kept for that scope. */
function memoryStorage() {
  const scopes = new Map<string, InMemoryArtifactStore>();
  return (scope: string) => {
    const store = scopes.get(scope) ?? new InMemoryArtifactStore();
    scopes.set(scope, store);
    return store;
  };
}

describeArtifactStore("In-memory", memoryStorage);
describeArtifactManager("In-memory", () => new InMemoryArtifactStore());
