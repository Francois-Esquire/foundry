import { expectTypeOf, test } from "vitest";
import type { z } from "zod";

import type { Extensions } from "../extensions";
import type {
  DefinitionReference,
  DefinitionReferenceSchema,
  ErrorShape,
  RunLinks,
  RunLinksSchema,
  RunRecord,
  RunRecordShapeSchema,
  RunStatus,
  RunTimestamps,
  WorkflowSnapshot,
} from "../schema";

/** The Run record contract callers had before the record moved to Zod. */
interface RunRecordContract {
  definition?: DefinitionReference;
  error: ErrorShape | null;
  extensions: Extensions;
  id: string;
  input: unknown;
  links?: RunLinks;
  metadata: Record<string, unknown>;
  output: unknown;
  queueId: string;
  snapshot: WorkflowSnapshot;
  status: RunStatus;
  step: string;
  tags: Record<string, string>;
  timestamps: RunTimestamps;
}

type Shape = (typeof RunRecordShapeSchema)["shape"];

test("RunRecord stays assignable to and from its contract", () => {
  expectTypeOf<RunRecord>().toExtend<RunRecordContract>();
  expectTypeOf<RunRecordContract>().toExtend<RunRecord>();
});

test("absent definition and links are exact optionals, never undefined", () => {
  // Under exactOptionalPropertyTypes the contract forbids an explicit
  // undefined; `.optional()` would infer `?: T | undefined` instead.
  expectTypeOf<Shape["definition"]>().toEqualTypeOf<
    z.ZodExactOptional<typeof DefinitionReferenceSchema>
  >();
  expectTypeOf<Shape["links"]>().toEqualTypeOf<
    z.ZodExactOptional<typeof RunLinksSchema>
  >();
});
