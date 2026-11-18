import type { TaskEvent, TaskStore } from "@foundry/tasks";
import { Tasks } from "@foundry/tasks";
import { MemoryTaskStore } from "@foundry/tasks/store/memory";
import { hostTaskStore, inLoad } from "~/authoring/runtime";
import type { Observable } from "~/lib/events/source";
import { observable, TASKS } from "~/lib/events/source";

const unhosted = new MemoryTaskStore();

function current(): TaskStore {
  return hostTaskStore() ?? unhosted;
}

const byStore = new WeakMap<TaskStore, Tasks>();

function tasksOver(store: TaskStore): Tasks {
  let over = byStore.get(store);
  if (over === undefined) {
    over = new Tasks({ store });
    byStore.set(store, over);
  }
  return over;
}

const calling = new Proxy(new Tasks({ store: unhosted }), {
  get(target, key, receiver) {
    const value: unknown = Reflect.get(target, key, receiver);
    if (typeof value !== "function") {
      return value;
    }
    return (...args: unknown[]): unknown => {
      let over: Tasks;
      try {
        over = tasksOver(current());
      } catch (error) {
        return Promise.reject(error);
      }
      const method = Reflect.get(over, key) as (...given: unknown[]) => unknown;
      return method.apply(over, args);
    };
  },
});

export const tasks: Tasks & Observable<TaskEvent> = observable(calling, TASKS);

const ofLoads = new Map<number, Tasks & Observable<TaskEvent>>();

export function tasksOfLoad(load: number): Tasks & Observable<TaskEvent> {
  let bound = ofLoads.get(load);
  if (bound === undefined) {
    bound = new Proxy(tasks, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]): unknown =>
          inLoad(load, () =>
            (value as (...given: unknown[]) => unknown).apply(target, args)
          );
      },
    });
    ofLoads.set(load, bound);
  }
  return bound;
}
