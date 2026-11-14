/**
 * Persisted records of the sandbox package: the shapes that cross the
 * {@link import("./container/store").ContainerStore} interface. Each schema is
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

const containerRowObjectSchema = z.object({
  /** Epoch milliseconds when the row was inserted. */
  createdAt: z.number(),
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
  updatedAt: z.number(),
});

/** One container in the registry: one row per container, one VM per row at a time. */
export const containerRowSchema = containerRowObjectSchema.readonly();

export type ContainerRow = z.infer<typeof containerRowSchema>;

/** The fields a store update may change. Identity and creation time are fixed. */
export const containerRowPatchSchema = containerRowObjectSchema
  .pick({ nativeId: true, spec: true, status: true, updatedAt: true })
  .partial()
  .readonly();

export type ContainerRowPatch = z.infer<typeof containerRowPatchSchema>;
