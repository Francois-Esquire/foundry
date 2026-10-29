import { Tasks } from "@foundry/tasks";

/**
 * The backlog Marbles creates for the process: what there is to do, what is
 * ready, what is done. A module imports it or not; nothing in Marbles reads
 * it. Held in memory, so nothing in it outlives the process.
 */
export const tasks = new Tasks();
