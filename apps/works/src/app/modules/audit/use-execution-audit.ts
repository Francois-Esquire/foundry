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

export function useExecutionAudit() {
  return useReducedStream<AuditEvent, AuditState | null>({
    initial: null,
    open: openAudit,
    reduce: applyAuditEvent,
  });
}
