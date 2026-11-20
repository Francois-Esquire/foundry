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

export class ModuleOffError extends ModuleRuntimeError {
  constructor() {
    super("This Module is off. Turn it on in the Module's page to use it.");
  }
}

export interface ModulePowerOptions {
  readonly execution: Pick<WorksExecution, "dispatch">;
  readonly file: string;
}

export interface PoweredPart {
  live?(moduleId: string): boolean;
  stop(moduleId: string): Promise<void>;
}

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

  async admit(moduleId: string): Promise<void> {
    if ((await this.#offModules()).has(moduleId)) {
      throw new ModuleOffError();
    }
  }

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
