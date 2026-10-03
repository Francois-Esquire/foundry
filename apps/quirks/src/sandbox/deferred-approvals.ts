import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

/** Only references to canonical session requests are stored here, never tool inputs. */
export class DeferredApprovals {
  readonly #path: string | undefined;
  readonly #records = new Map<string, DeferredApproval>();
  readonly #sessions = new Map<string, InteractionSession>();
  #writes: Promise<void> = Promise.resolve();

  constructor(path?: string) {
    this.#path = path;
  }

  async load(): Promise<{
    requests: readonly DeferredApproval[];
    sessions: readonly InteractionSession[];
  }> {
    if (this.#path) {
      let raw: string;
      try {
        raw = await readFile(this.#path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { requests: [], sessions: [] };
        }
        throw error;
      }
      const saved = z
        .object({
          requests: z.array(recordSchema),
          sessions: z.array(sessionSchema),
        })
        .parse(JSON.parse(raw));
      for (const session of saved.sessions) {
        this.#sessions.set(session.sessionId, session);
      }
      const records = saved.requests;
      for (const record of records) {
        this.#records.set(record.approvalId, record);
      }
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
    const path = this.#path;
    if (!path) {
      return Promise.resolve();
    }
    const data = JSON.stringify({
      requests: [...this.#records.values()],
      sessions: [...this.#sessions.values()],
    });
    const save = async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, path);
    };
    this.#writes = this.#writes.then(save, save);
    return this.#writes;
  }
}
