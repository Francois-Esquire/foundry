import { MemoryWorkflowStore } from "../store/memory";
import { describeWorkflowStore } from "../testing/store";

describeWorkflowStore("MemoryWorkflowStore", () => {
  const stores = new Map<string, MemoryWorkflowStore>();
  return (scope) => {
    let store = stores.get(scope);
    if (store === undefined) {
      store = new MemoryWorkflowStore();
      stores.set(scope, store);
    }
    return store;
  };
});
