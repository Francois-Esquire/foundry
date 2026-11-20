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
export const deferredApprovalsSchema = z.object({
  requests: z.array(recordSchema),
  sessions: z.array(sessionSchema),
});
export type SavedApprovals = z.infer<typeof deferredApprovalsSchema>;

export interface DeferredApprovalStore {
  change(update: (saved: SavedApprovals) => SavedApprovals): Promise<void>;
  load(): Promise<SavedApprovals>;
}

export function emptyApprovals(): SavedApprovals {
  return { requests: [], sessions: [] };
}

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
