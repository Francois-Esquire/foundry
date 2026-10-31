import type { TaskEvent, TaskStore } from "@foundry/tasks";
import { MemoryTaskStore, Tasks } from "@foundry/tasks";
import { hostTaskStore } from "~/authoring/runtime";
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

/** The store each call reaches: the host's, decided per call. */
function current(): TaskStore {
  return hostTaskStore() ?? unhosted;
}

const hosted: TaskStore = {
  commit: (write) => current().commit(write),
  get: (id) => current().get(id),
  snapshot: () => current().snapshot(),
  // A whole read-modify-write stays on the store it began on.
  transaction: (work) => {
    const store = current();
    return store.transaction === undefined
      ? work(store)
      : store.transaction(work);
  },
};

export const tasks: Tasks & Observable<TaskEvent> = observable(
  new Tasks({ store: hosted }),
  TASKS
);
