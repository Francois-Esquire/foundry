import type { TaskEvent, TaskStore } from "@foundry/tasks";
import { Tasks } from "@foundry/tasks";
import { MemoryTaskStore } from "@foundry/tasks/store/memory";
import { hostTaskStore } from "~/authoring/runtime";
import type { Observable } from "~/lib/events/source";
import { observable, TASKS } from "~/lib/events/source";

interface TasksState {
  readonly byStore: WeakMap<TaskStore, Tasks>;
  readonly unhosted: MemoryTaskStore;
}

const TASKS_STATE_KEY = Symbol.for("marbles.tasks.state.v1");

function tasksState(): TasksState {
  const holder = globalThis as Record<symbol, TasksState | undefined>;
  let state = holder[TASKS_STATE_KEY];
  if (state === undefined) {
    state = {
      byStore: new WeakMap<TaskStore, Tasks>(),
      unhosted: new MemoryTaskStore(),
    };
    holder[TASKS_STATE_KEY] = state;
  }
  return state;
}

function current(): TaskStore {
  return hostTaskStore() ?? tasksState().unhosted;
}

function tasksOver(store: TaskStore): Tasks {
  const { byStore } = tasksState();
  let over = byStore.get(store);
  if (over === undefined) {
    over = new Tasks({ store });
    byStore.set(store, over);
  }
  return over;
}

const calling = new Proxy(new Tasks({ store: tasksState().unhosted }), {
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
