import { readJsonFile, writeFileAtomic } from "@foundry/lib/atomic-file";
import { KeyedTurns } from "@foundry/modules/platform/turns";
import { z } from "zod";
import { WORKS_TASKS } from "~/shared/execution";
import type { ModulePowerView } from "~/shared/module-power";
import { OBSERVATION } from "~/shared/observations";
import type { WorksExecution } from "../execution/contract";
import { ModuleRuntimeError } from "./runtime/controller";

const RECORD_FORMAT = "works.module-power/1";

const recordSchema = z.object({
  format: z.literal(RECORD_FORMAT),
  off: z.array(z.string()),
});

/** A runtime refusal, so every surface (app, preview, build, chat) shows its message. */
export class ModuleOffError extends ModuleRuntimeError {
  constructor() {
    super("This Module is off. Turn it on in the Module's page to use it.");
  }
}

export interface ModulePowerOptions {
  readonly execution: Pick<WorksExecution, "dispatch">;
  /** Works state: which Modules the user turned off. */
  readonly file: string;
}

/** Something a Module's power governs: its apps, or its sandbox. */
export interface PoweredPart {
  /** Whether the Module's part is live now; a live one shows as its sandbox. */
  live?(moduleId: string): boolean;
  /** Module off: stop the Module's part, resolving once cleanup is confirmed. */
  stop(moduleId: string): Promise<void>;
}

/**
 * Turns Modules on and off. A Module is on unless the user turned it off.
 * While it is on, its sandbox, once started, stays on even when idle; off
 * refuses new work, stops its apps and removes its sandbox, and stays off
 * across restarts until turned on. Each change is a `system` engine run.
 */
export class ModulePower {
  readonly #execution: ModulePowerOptions["execution"];
  readonly #file: string;
  readonly #parts: PoweredPart[] = [];
  readonly #writes = new KeyedTurns<string>();
  #off: Promise<Set<string>> | undefined;

  constructor(options: ModulePowerOptions) {
    this.#execution = options.execution;
    this.#file = options.file;
  }

  /**
   * Govern `part` too: Module off stops it, after the parts governed before
   * it (apps before the sandbox they run in).
   */
  govern(part: PoweredPart): void {
    this.#parts.push(part);
  }

  async get(moduleId: string): Promise<ModulePowerView> {
    const on = !(await this.#offModules()).has(moduleId);
    return {
      moduleId,
      on,
      sandbox: on && this.#parts.some((part) => part.live?.(moduleId)),
    };
  }

  /** Throws `ModuleOffError` when the Module is off. */
  async admit(moduleId: string): Promise<void> {
    if ((await this.#offModules()).has(moduleId)) {
      throw new ModuleOffError();
    }
  }

  /**
   * Off is recorded first, so nothing new starts while the Module's apps and
   * sandbox stop; it resolves once their cleanup is confirmed. A failed
   * cleanup leaves the Module off: turning it off again retries.
   */
  set(moduleId: string, on: boolean): Promise<ModulePowerView> {
    return this.#execution.dispatch(
      WORKS_TASKS.power,
      { correlation: { moduleId } },
      async (context) => {
        await this.#writes.run("record", async () => {
          const off = new Set(await this.#offModules());
          if (on) {
            off.delete(moduleId);
          } else {
            off.add(moduleId);
          }
          await writeRecord(this.#file, [...off].sort());
          this.#off = Promise.resolve(off);
        });
        if (!on) {
          for (const part of this.#parts) {
            await part.stop(moduleId);
          }
        }
        context.observe({
          data: { moduleId, on },
          kind: "result",
          type: OBSERVATION.power,
        });
        return this.get(moduleId);
      }
    );
  }

  #offModules(): Promise<Set<string>> {
    this.#off ??= readRecord(this.#file).catch((error: unknown) => {
      this.#off = undefined;
      throw error;
    });
    return this.#off;
  }
}

async function readRecord(file: string): Promise<Set<string>> {
  const value = await readJsonFile(file);
  if (value === undefined) {
    return new Set();
  }
  const record = recordSchema.safeParse(value);
  if (!record.success) {
    throw new Error(
      "The Module on/off record was written by another Works version"
    );
  }
  return new Set(record.data.off);
}

function writeRecord(file: string, off: readonly string[]): Promise<void> {
  return writeFileAtomic(file, JSON.stringify({ format: RECORD_FORMAT, off }), {
    directoryMode: 0o700,
    mode: 0o600,
  });
}
