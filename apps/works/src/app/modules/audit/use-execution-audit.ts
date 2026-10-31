import { worksApi } from "~/app/api/client";
import { useReducedStream } from "~/app/lib/use-reduced-stream";
import {
  type AuditEvent,
  type AuditState,
  applyAuditEvent,
} from "~/shared/audit";

function openAudit(signal: AbortSignal) {
  return worksApi().audit.watch.call(undefined, { signal });
}

/**
 * Follows the engine run store: a snapshot, then each change, reconciled by
 * run id and revision.
 */
export function useExecutionAudit() {
  return useReducedStream<AuditEvent, AuditState | null>({
    initial: null,
    open: openAudit,
    reduce: applyAuditEvent,
  });
}
