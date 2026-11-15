import type { TaskEvent, TaskStore } from "@foundry/tasks";
import { Tasks } from "@foundry/tasks";
import { MemoryTaskStore } from "@foundry/tasks/store/memory";
import { hostTaskStore, inLoad } from "~/authoring/runtime";
import type { Observable } from "~/lib/events/source";
import { observable, TASKS } from "~/lib/events/source";

/**
 * The backlog Marbles creates for the process: what there is to do, what is
 * ready, what is done. A module imports it or not, and may `observe` it.
 *
 * Under a host (the worker the Marbles process runs for a workspace, or a
 * program calling `hostWorkspace`) it is that workspace's tasks, kept with
 * the host's state, and every change it commits is delivered to the
 * workspace's observers. A host refuses them
 * while its source loads, before its engine is bound, and once that engine
 * is disposed, until another is bound. In a script no host loaded, it is
 * held in this process's memory, nothing in it outlives the process, and
 * nothing is delivered.
 */

const unhosted = new MemoryTaskStore();

/** The store a call reaches: the calling workspace's host's, decided as the call is made. */
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

/**
 * Each method decides its workspace's store as it is called, while the
 * caller's own code is on the stack and names its workspace; the package
 * awaits before it reaches its store, by which time it would not. The
 * whole call, a read-modify-write included, then stays on that store.
 */
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

/**
 * The builtin `tasks` as load `load`'s modules import it: every call runs
 * as that load's, so it reaches that load's workspace, or is refused once
 * that workspace's host has closed, from wherever it is made.
 */
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
