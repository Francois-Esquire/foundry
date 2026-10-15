import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readJsonFile, writeFileAtomic } from "@foundry/lib/atomic-file";
import { withFileLock } from "@foundry/lib/file-lock";
import { KeyedQueue } from "@foundry/lib/keyed-queue";
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
type Change = (saved: Saved) => Saved;

interface Backing {
  change(update: Change): Promise<void>;
  load(): Promise<Saved>;
}

function empty(): Saved {
  return { requests: [], sessions: [] };
}

function memory(): Backing {
  let saved = empty();
  return {
    change(update) {
      saved = update(saved);
      return Promise.resolve();
    },
    load: () => Promise.resolve(structuredClone(saved)),
  };
}

/** Same-process writers take turns before acquiring the non-reentrant file lock. */
const queue = new KeyedQueue();

function file(location: string): Backing {
  const path = resolve(location);
  const load = async (): Promise<Saved> => {
    const value = await readJsonFile(path);
    return value === undefined ? empty() : savedSchema.parse(value);
  };
  return {
    change: (update) =>
      queue.run(path, async () => {
        await mkdir(dirname(path), { recursive: true });
        await withFileLock(
          `${path}.lock`,
          async () => {
            const saved = update(await load());
            await writeFileAtomic(path, JSON.stringify(saved), { mode: 0o600 });
          },
          { breakStale: true }
        );
      }),
    load: () => queue.run(path, load),
  };
}

/**
 * References to canonical session requests, never tool inputs. Each edit reads
 * the latest index under lock, so overlapping hosts preserve each other's work.
 */
export class DeferredApprovals {
  readonly #backing: Backing;

  constructor(path?: string) {
    this.#backing = path ? file(path) : memory();
  }

  load(): Promise<Saved> {
    return this.#backing.load();
  }

  register(session: InteractionSession): Promise<void> {
    return this.#backing.change((saved) => ({
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
    return this.#backing.change((saved) => ({
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
    return this.#backing.change((saved) => ({
      ...saved,
      requests: saved.requests.filter((item) => item.approvalId !== id),
    }));
  }
}
