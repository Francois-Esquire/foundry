import type { ContainerStore } from "../store/index";
import { createMemoryContainerStore } from "../store/memory";
import { describeContainerStore } from "../testing/store";

describeContainerStore("memory", () => {
  const stores = new Map<string, ContainerStore>();
  return (scope) => {
    const store = stores.get(scope) ?? createMemoryContainerStore();
    stores.set(scope, store);
    return store;
  };
});
