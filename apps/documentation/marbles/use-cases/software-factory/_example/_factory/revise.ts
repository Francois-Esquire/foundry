import { step } from "@foundry.sh/marbles";
import { z } from "zod";
import {
  issueInput,
  maxAttempts,
  recordEvent,
  recordSchema,
  requireRecord,
} from "./record";

export const revisionInput = issueInput.extend({ note: z.string().min(1) });
export const revise = step("factory-revision-request")
  .input(revisionInput)
  .output(recordSchema)
  .do(async ({ input, run }) => {
    const work = await requireRecord(input.issue);
    if (
      !(
        work.change &&
        work.plan &&
        ["needs-changes", "declined", "pr-open"].includes(work.status)
      )
    ) {
      throw new Error(
        "Revise a reviewed candidate. Reconcile blocked work before continuing."
      );
    }
    if (work.attempts >= maxAttempts) {
      throw new Error("Attempt limit reached. Record a handoff for a person.");
    }
    return recordEvent(
      {
        ...work,
        decision: undefined,
        status: "planned",
        verification: undefined,
      },
      run.id,
      "revision requested",
      input.note
    );
  });
