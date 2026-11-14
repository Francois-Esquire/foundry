import { useCallback, useState } from "react";
import { worksApi } from "~/app/api/client";
import {
  type StreamConnection,
  useReducedStream,
} from "~/app/lib/use-reduced-stream";
import {
  type AuthoringAnswer,
  type AuthoringConversationView,
  type AuthoringEvent,
  applyAuthoringEvent,
} from "~/shared/authoring";
import type { ProposalConflict } from "./proposal";
import type { DraftProposals } from "./use-module-editor";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** A dropped conversation reconnects by itself; say so while it is away. */
function streamProblem(connection: StreamConnection, error: string): string {
  if (connection === "failed") {
    return error;
  }
  return connection === "reconnecting" ? `${error} Reconnecting…` : "";
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * One Module's conversation: followed from main while the workspace is open,
 * so leaving it stops only the watch, never a turn. Accepting a proposal
 * reconciles it into the Draft here, in the renderer that owns the Draft.
 */
export function useModuleChat(moduleId: string, draft: DraftProposals) {
  const open = useCallback(
    (signal: AbortSignal) =>
      worksApi().authoring.watch.call({ id: moduleId }, { signal }),
    [moduleId]
  );
  const stream = useReducedStream<
    AuthoringEvent,
    AuthoringConversationView | null
  >({ initial: null, open, reduce: applyAuthoringEvent });
  const [actionError, setError] = useState("");
  const [status, setStatus] = useState("");
  /** Proposals whose saved source moved, by turn. */
  const [stale, setStale] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  /** Send with the Draft as it is now; resolves whether it was sent. */
  const send = useCallback(
    async (prompt: string) => {
      const { expected: binding, source } = draft.current();
      if (!binding) {
        setError("This module has no editable source.");
        return false;
      }
      setSending(true);
      setError("");
      try {
        await worksApi().authoring.send.call({
          binding,
          id: moduleId,
          prompt,
          source: { ...source },
        });
        return true;
      } catch (caught) {
        setError(errorMessage(caught, "The request could not be sent."));
        return false;
      } finally {
        setSending(false);
      }
    },
    [draft, moduleId]
  );

  const run = useCallback(
    async (work: () => Promise<unknown>, fallback: string) => {
      setError("");
      try {
        await work();
      } catch (caught) {
        setError(errorMessage(caught, fallback));
      }
    },
    []
  );

  const cancel = useCallback(
    (turnId: string) =>
      run(
        () => worksApi().authoring.cancel.call({ id: moduleId, turnId }),
        "The request could not be cancelled."
      ),
    [moduleId, run]
  );

  const answer = useCallback(
    (turnId: string, inputId: string, value: AuthoringAnswer) =>
      run(
        () =>
          worksApi().authoring.answer.call({
            answer: value,
            id: moduleId,
            inputId,
            turnId,
          }),
        "The answer could not be sent."
      ),
    [moduleId, run]
  );

  const settle = useCallback(
    (turnId: string, outcome: "applied" | "dismissed") =>
      worksApi().authoring.settle.call({
        id: moduleId,
        status: outcome,
        turnId,
      }),
    [moduleId]
  );

  const accept = useCallback(
    (turnId: string) =>
      run(async () => {
        const result = await worksApi().authoring.accept.call({
          id: moduleId,
          turnId,
        });
        if (result.status === "stale") {
          setStale((current) => ({ ...current, [turnId]: result.message }));
          setStatus(result.message);
          return;
        }
        const outcome = draft.accept(turnId, result);
        if (outcome.conflicts === 0) {
          await settle(turnId, "applied");
          setStatus(
            outcome.applied === 0
              ? "Your draft already has these changes."
              : `Applied ${plural(outcome.applied, "file")} to your draft. Save to keep them.`
          );
          return;
        }
        setStatus(
          `Applied ${plural(outcome.applied, "file")}. ${plural(outcome.conflicts, "file")} conflict with your draft; resolve them in Changes.`
        );
      }, "The proposal could not be applied."),
    [draft, moduleId, run, settle]
  );

  const dismiss = useCallback(
    (turnId: string) =>
      run(async () => {
        await settle(turnId, "dismissed");
        draft.drop(turnId);
        setStale(({ [turnId]: _dropped, ...rest }) => rest);
        setStatus("Proposal dismissed.");
      }, "The proposal could not be dismissed."),
    [draft, run, settle]
  );

  const proposal = useCallback(
    (turnId: string) =>
      worksApi().authoring.proposal.call({ id: moduleId, turnId }),
    [moduleId]
  );

  /**
   * After saved source moved: hold every file the proposal would change as
   * a conflict, so each is chosen by hand with both versions in view.
   */
  const resolveByHand = useCallback(
    (turnId: string) =>
      run(async () => {
        const held = draft.holdAll(turnId, await proposal(turnId));
        if (held === 0) {
          await settle(turnId, "applied");
          setStatus("Your draft already matches the proposal.");
        } else {
          setStatus(`${plural(held, "file")} to resolve by hand in Changes.`);
        }
        setStale(({ [turnId]: _dropped, ...rest }) => rest);
      }, "The proposal could not be loaded."),
    [draft, proposal, run, settle]
  );

  const resolveConflict = useCallback(
    (conflict: ProposalConflict, choice: "draft" | "proposal") =>
      run(async () => {
        if (draft.resolve(conflict, choice) === 0) {
          await settle(conflict.turnId, "applied");
          setStatus("All conflicts resolved. Save to keep the result.");
        }
      }, "The conflict could not be resolved."),
    [draft, run, settle]
  );

  return {
    accept,
    answer,
    cancel,
    conversation: stream.state,
    dismiss,
    error: actionError || streamProblem(stream.connection, stream.error),
    proposal,
    resolveByHand,
    resolveConflict,
    send,
    sending,
    stale,
    status,
  };
}

export type ModuleChat = ReturnType<typeof useModuleChat>;
