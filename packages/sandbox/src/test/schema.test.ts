import { describe, expect, it } from "vitest";

import { CONTAINER_ROW_STATUSES } from "../container/constants";
import {
  containerRowPatchSchema,
  containerRowSchema,
  containerRowStatusSchema,
} from "../schema";

const row = {
  createdAt: 1,
  id: "c1",
  nativeId: undefined,
  spec: "{}",
  status: "starting",
  updatedAt: 1,
} as const;

describe("container row schema", () => {
  it("is the one source of the persisted statuses", () => {
    expect(CONTAINER_ROW_STATUSES).toEqual(containerRowStatusSchema.options);
    expect(Object.isFrozen(CONTAINER_ROW_STATUSES)).toBe(true);
  });

  it("accepts a row before and after its first start", () => {
    expect(containerRowSchema.parse(row)).toEqual(row);
    expect(
      containerRowSchema.parse({ ...row, nativeId: "c1-1", status: "running" })
    ).toEqual({ ...row, nativeId: "c1-1", status: "running" });
  });

  it("rejects an unknown status", () => {
    expect(
      containerRowSchema.safeParse({ ...row, status: "paused" }).success
    ).toBe(false);
  });

  it("accepts every id and timestamp the store accepts", () => {
    const loose = { ...row, createdAt: 1.5, id: "", updatedAt: -1 };
    expect(containerRowSchema.parse(loose)).toEqual(loose);
    for (const timestamp of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const odd = { ...row, createdAt: timestamp, updatedAt: timestamp };
      expect(containerRowSchema.parse(odd)).toEqual(odd);
    }
    expect(
      containerRowSchema.safeParse({ ...row, createdAt: "1" }).success
    ).toBe(false);
  });

  it("limits a patch to the fields an update may change", () => {
    expect(containerRowPatchSchema.parse({ status: "stopped" })).toEqual({
      status: "stopped",
    });
    expect(containerRowPatchSchema.parse({ id: "c2" })).toEqual({});
  });
});
