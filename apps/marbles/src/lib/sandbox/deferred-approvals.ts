import { readJsonFile, writeFileAtomic } from "@foundry/lib/atomic-file";
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
const savedSchema = z.object({
  requests: z.array(recordSchema),
  sessions: z.array(sessionSchema),
});
type Saved = z.infer<typeof savedSchema>;

/** Where the references live: a private file, or nowhere for a host without state. */
interface Backing {
  load(): Promise<Saved>;
  save(saved: Saved): Promise<void>;
}

const EMPTY: Saved = { requests: [], sessions: [] };

const memory: Backing = {
  load: () => Promise.resolve(EMPTY),
  save: () => Promise.resolve(),
};

function file(path: string): Backing {
  return {
    async load() {
      const value = await readJsonFile(path);
      return value === undefined ? EMPTY : savedSchema.parse(value);
    },
    save: (saved) =>
      writeFileAtomic(path, JSON.stringify(saved), {
        createDirectory: true,
        mode: 0o600,
      }),
  };
}

/** Only references to canonical session requests are stored here, never tool inputs. */
export class DeferredApprovals {
  readonly #backing: Backing;
  readonly #records = new Map<string, DeferredApproval>();
  readonly #sessions = new Map<string, InteractionSession>();
  #writes: Promise<void> = Promise.resolve();

  /** Without a path, references are kept for this process only. */
  constructor(path?: string) {
    this.#backing = path ? file(path) : memory;
  }

  async load(): Promise<{
    requests: readonly DeferredApproval[];
    sessions: readonly InteractionSession[];
  }> {
    const saved = await this.#backing.load();
    for (const session of saved.sessions) {
      this.#sessions.set(session.sessionId, session);
    }
    for (const record of saved.requests) {
      this.#records.set(record.approvalId, record);
    }
    return {
      requests: [...this.#records.values()],
      sessions: [...this.#sessions.values()],
    };
  }

  register(session: InteractionSession): Promise<void> {
    this.#sessions.set(session.sessionId, session);
    return this.#save();
  }

  put(record: DeferredApproval): Promise<void> {
    this.#records.set(record.approvalId, record);
    return this.#save();
  }

  remove(id: string): Promise<void> {
    this.#records.delete(id);
    return this.#save();
  }

  #save(): Promise<void> {
    const saved = {
      requests: [...this.#records.values()],
      sessions: [...this.#sessions.values()],
    };
    const save = () => this.#backing.save(saved);
    this.#writes = this.#writes.then(save, save);
    return this.#writes;
  }
}
