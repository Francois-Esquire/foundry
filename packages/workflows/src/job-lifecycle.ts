import type { DispatchedWorkflow } from "./dispatched-workflow";
import {
  JobAlreadySettledError,
  JobAttemptAlreadyActiveError,
  JobNotFoundError,
} from "./errors";
import type {
  JobCancellation,
  JobLinks,
  JobQuery,
  JobRecord,
  JsonValue,
  OrchestratorStore,
  Page,
  RunRecord,
} from "./store";

export interface CreateJobOptions {
  readonly links?: JobLinks;
  readonly version?: string;
}

type ExecuteJob = (job: JobRecord) => Promise<DispatchedWorkflow<JsonValue>>;

/** Optional Job management layer above bounded Run attempts. */
export class JobLifecycle {
  readonly #store: OrchestratorStore;
  readonly #executeJob: ExecuteJob;
  readonly #mutationTails = new Map<string, Promise<void>>();

  constructor(args: { store: OrchestratorStore; executeJob: ExecuteJob }) {
    this.#store = args.store;
    this.#executeJob = args.executeJob;
  }

  create(
    definition: string,
    input: JsonValue,
    options: CreateJobOptions = {}
  ): Promise<JobRecord> {
    return this.#store.createJob({
      definition: {
        name: definition,
        ...(options.version === undefined ? {} : { version: options.version }),
      },
      input,
      links: options.links,
    });
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const job = await this.#store.getJob(jobId);
    return job ? this.#project(job) : null;
  }

  async list(query: JobQuery = {}): Promise<Page<JobRecord>> {
    const page = await this.#store.listJobs(query);
    return {
      ...page,
      items: (
        await Promise.all(page.items.map((job) => this.#project(job)))
      ).filter((job) => matchesJobQuery(job, query)),
    };
  }

  execute(jobId: string): Promise<DispatchedWorkflow<JsonValue>> {
    return this.#withJobLock(jobId, async () => {
      const stored = await this.#store.getJob(jobId);
      if (!stored) {
        throw new JobNotFoundError(jobId);
      }
      const job = await this.#project(stored);
      if (
        job.status === "complete" ||
        job.status === "failed" ||
        job.status === "cancelled"
      ) {
        throw new JobAlreadySettledError(jobId);
      }
      const active = await this.#activeRun(jobId);
      if (active) {
        throw new JobAttemptAlreadyActiveError(jobId, active.id);
      }

      const dispatched = await this.#executeJob(job);
      void dispatched
        .result()
        .then(() => this.#projectById(jobId))
        .catch(() => undefined);
      return dispatched;
    });
  }

  cancel(jobId: string): Promise<JobCancellation> {
    return this.#withJobLock(jobId, () => this.#store.cancelJob(jobId));
  }

  async #projectById(jobId: string): Promise<void> {
    const job = await this.#store.getJob(jobId);
    if (job) {
      await this.#project(job);
    }
  }

  async #project(job: JobRecord): Promise<JobRecord> {
    if (
      job.status === "complete" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      return job;
    }
    const active = (
      await this.#store.listRuns({
        limit: 1,
        links: { jobId: job.id },
        status: ["queued", "running", "suspended"],
      })
    ).items[0];
    const completed = active
      ? false
      : (
          await this.#store.listRuns({
            limit: 1,
            links: { jobId: job.id },
            status: "complete",
          })
        ).items.length > 0;
    const nextStatus = active
      ? active.status === "suspended"
        ? "waiting"
        : "active"
      : completed
        ? "complete"
        : "pending";
    if (nextStatus === job.status) {
      return job;
    }

    const updated = await this.#store.updateJob(job.id, {
      status: nextStatus,
      ...(nextStatus === "complete"
        ? { timestamps: { completedAt: Date.now() } }
        : {}),
    });
    if (!updated) {
      throw new JobNotFoundError(job.id);
    }
    return updated;
  }

  async #activeRun(jobId: string): Promise<RunRecord | null> {
    const runs = await this.#store.listRuns({
      limit: 1,
      links: { jobId },
      status: ["queued", "running", "suspended"],
    });
    return runs.items[0] ?? null;
  }

  async #withJobLock<T>(jobId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTails.get(jobId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#mutationTails.set(jobId, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#mutationTails.get(jobId) === current) {
        this.#mutationTails.delete(jobId);
      }
    }
  }
}

function matchesJobQuery(job: JobRecord, query: JobQuery): boolean {
  if (query.status !== undefined) {
    const statuses = Array.isArray(query.status)
      ? query.status
      : [query.status];
    if (!statuses.includes(job.status)) {
      return false;
    }
  }
  if (
    query.definition !== undefined &&
    job.definition.name !== query.definition
  ) {
    return false;
  }
  if (query.links !== undefined) {
    for (const [key, value] of Object.entries(query.links)) {
      if (job.links[key as keyof JobLinks] !== value) {
        return false;
      }
    }
  }
  return true;
}
