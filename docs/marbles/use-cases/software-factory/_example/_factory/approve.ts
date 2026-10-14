import { step, workflow } from "@foundry.sh/marbles";
import { publish } from "./publish";
import {
  chronicle,
  issueInput,
  recordEvent,
  recordSchema,
  requireRecord,
  workInput,
} from "./record";

const load = step("factory-load")
  .input(issueInput)
  .output(recordSchema)
  .do(({ input }) => requireRecord(input.issue));
const approve = step("factory-approve")
  .input(workInput)
  .output(recordSchema)
  .do(async ({ input: { work }, ask, run }) => {
    if (
      work.status === "approved" &&
      work.decision?.approved &&
      work.change?.revision === work.decision.revision &&
      work.verification?.revision === work.decision.revision
    ) {
      return work;
    }
    if (
      work.status !== "verified" ||
      !work.change ||
      work.verification?.revision !== work.change.revision
    ) {
      throw new Error(
        "Verify the current candidate before requesting publication."
      );
    }
    const decision = await ask.approval({
      body: `${chronicle(work)}\n\nApproval permits pushing this commit and opening or updating its pull request.`,
      title: `Publish ${work.issue.number} at ${work.change.revision}?`,
    });
    return recordEvent(
      {
        ...work,
        decision: {
          approved: decision.approved,
          note: decision.note ?? "",
          revision: work.change.revision,
        },
        status: decision.approved ? "approved" : "declined",
      },
      run.id,
      "publication decision",
      `${decision.approved ? "Approved" : "Declined"}: ${decision.note ?? ""}`
    );
  });
workflow("factory-deliver")
  .input(issueInput)
  .do(({ input }) => publish({ work: approve({ work: load({}, input) }) }));
