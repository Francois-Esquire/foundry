import { z } from "zod";

const recordSchema = z.object({
  agentGeneration: z.number().optional(),
  agentId: z.string().min(1),
  approvalId: z.string().min(1),
  sessionId: z.string().min(1),
  source: z.object({
    definition: z.string(),
    path: z.array(z.string()),
    runId: z.string(),
  }),
});
export type DeferredApproval = z.infer<typeof recordSchema>;
const sessionSchema = recordSchema.omit({ approvalId: true });
export type InteractionSession = z.infer<typeof sessionSchema>;
/** What is kept: the requests waiting for a person, and the sessions they come from. */
export const deferredApprovalsSchema = z.object({
  requests: z.array(recordSchema),
  sessions: z.array(sessionSchema),
});
export type SavedApprovals = z.infer<typeof deferredApprovalsSchema>;

/**
 * Where a workspace's deferred approvals are kept: the Marbles database's
 * for a host (`database/approvals.ts`), memory otherwise. `change` reads
 * what is kept and writes what `update` makes of it as one transaction,
 * so overlapping hosts keep each other's work.
 */
export interface DeferredApprovalStore {
  change(update: (saved: SavedApprovals) => SavedApprovals): Promise<void>;
  load(): Promise<SavedApprovals>;
}

export function emptyApprovals(): SavedApprovals {
  return { requests: [], sessions: [] };
}

/** Deferred approvals in this process's memory, as long as it lasts. */
export class MemoryDeferredApprovalStore implements DeferredApprovalStore {
  #saved = emptyApprovals();

  change(update: (saved: SavedApprovals) => SavedApprovals): Promise<void> {
    this.#saved = update(structuredClone(this.#saved));
    return Promise.resolve();
  }

  load(): Promise<SavedApprovals> {
    return Promise.resolve(structuredClone(this.#saved));
  }
}

/**
 * References to canonical session requests, never tool inputs. Each edit
 * reads the latest of what `store` keeps in the same transaction, so
 * overlapping hosts preserve each other's work.
 */
export class DeferredApprovals {
  readonly #store: DeferredApprovalStore;

  constructor(
    store: DeferredApprovalStore = new MemoryDeferredApprovalStore()
  ) {
    this.#store = store;
  }

  load(): Promise<SavedApprovals> {
    return this.#store.load();
  }

  register(session: InteractionSession): Promise<void> {
    return this.#store.change((saved) => ({
      ...saved,
      sessions: [
        ...saved.sessions.filter(
          (item) => item.sessionId !== session.sessionId
        ),
        session,
      ],
    }));
  }

  put(record: DeferredApproval): Promise<void> {
    return this.#store.change((saved) => ({
      ...saved,
      requests: [
        ...saved.requests.filter(
          (item) => item.approvalId !== record.approvalId
        ),
        record,
      ],
    }));
  }

  remove(id: string): Promise<void> {
    return this.#store.change((saved) => ({
      ...saved,
      requests: saved.requests.filter((item) => item.approvalId !== id),
    }));
  }
}
