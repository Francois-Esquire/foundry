/**
 * Persisted records of the sandbox package: the shapes that cross the
 * {@link import("./store/index").ContainerStore} interface. Each schema is
 * the single definition of its record; the TypeScript types are inferred.
 * The schemas state shape only, as the store enforces nothing more: an id is
 * any string and a timestamp any number.
 *
 * Imports only Zod and plain constants, so the runtime-free store contract can
 * import these types without loading a provider.
 */
import { z } from "zod";

import { CONTAINER_ROW_STATUSES } from "./container/constants";

export const containerRowStatusSchema = z.enum(CONTAINER_ROW_STATUSES);

export type ContainerRowStatus = z.infer<typeof containerRowStatusSchema>;

/**
 * Any number, as the store accepts. `z.number()` would reject NaN and the
 * infinities, which the store passes through unchanged.
 */
const timestampSchema = z.custom<number>((value) => typeof value === "number");

const containerRowObjectSchema = z.object({
  /** Epoch milliseconds when the row was inserted. */
  createdAt: timestampSchema,
  /**
   * Who holds the row: the registry that last claimed it, by the opaque
   * token it was given (`CreateContainersOptions.holder`). A registry
   * takes a row over only while its holder is still the one it judged,
   * in one store transaction. Undefined on a row written before holders.
   */
  holder: z.string().optional(),
  id: z.string(),
  /** The runtime's name for the VM realizing this row. Undefined until the first start. */
  nativeId: z.string().or(z.undefined()),
  /**
   * The approved container constraints as JSON. Opaque here: parsing needs
   * the constraints schema from `./container/constraints`, which would break
   * the runtime-free store contract. The registry parses; the store carries
   * bytes.
   */
  spec: z.string(),
  status: containerRowStatusSchema,
  /** Epoch milliseconds of the last write to the row. */
  updatedAt: timestampSchema,
});

/** One container in the registry: one row per container, one VM per row at a time. */
export const containerRowSchema = containerRowObjectSchema.readonly();

export type ContainerRow = z.infer<typeof containerRowSchema>;

/** What every change event carries: its own id, when, and the container. */
const changeEventFields = {
  /** When the change happened, as the row it changed stamps it, in ISO form. */
  at: z.iso.datetime(),
  containerId: z.string(),
  /** Unique to this event. */
  id: z.string().min(1),
};

/**
 * One past change to a container, built by the containers registry and
 * carried in the store write that makes it (`ContainerStoreWrite.events`),
 * so a host's `onCommit` can record it with the change:
 *
 * - `sandbox.created`: a container's row was inserted, by `start`.
 * - `sandbox.started`: its VM came up, and the row entered `running`, on a
 *   first boot, a reopen (after a failure too) or a restart.
 * - `sandbox.stopped`: its VM was stopped, and the row entered `stopped`,
 *   when its last handle closed or the registry shut down.
 * - `sandbox.failed`: its VM did not come up, and the row entered `failed`.
 * - `sandbox.destroyed`: its row was deleted, by `remove`.
 */
export const sandboxEventSchema = z.discriminatedUnion("type", [
  z.object({ ...changeEventFields, type: z.literal("sandbox.created") }),
  z.object({ ...changeEventFields, type: z.literal("sandbox.started") }),
  z.object({ ...changeEventFields, type: z.literal("sandbox.stopped") }),
  z.object({ ...changeEventFields, type: z.literal("sandbox.failed") }),
  z.object({ ...changeEventFields, type: z.literal("sandbox.destroyed") }),
]);

export type SandboxEvent = z.infer<typeof sandboxEventSchema>;
