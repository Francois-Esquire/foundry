import path from "node:path";
import { readJsonFile, writeFileAtomic } from "@foundry/lib/atomic-file";
import {
  type ModuleManifest,
  moduleSettingRequests,
} from "@foundry/modules/manifest";
import { KeyedTurns } from "@foundry/modules/platform/turns";
import {
  type EffectiveModuleSettings,
  MODULE_SETTING_HOST_POLICY,
  MODULE_SETTING_KEYS,
  ModuleSettingsError,
  type ModuleSettingsHostPolicy,
  type ModuleSettingValues,
  parseModuleSettingValues,
  requireModuleSettings,
  resolveModuleSettings,
  withModuleSettingDefaults,
} from "@foundry/modules/settings";
import { z } from "zod";
import { WORKS_TASKS } from "~/shared/execution";
import type { ModuleSettingsView } from "~/shared/module-settings";
import { OBSERVATION } from "~/shared/observations";
import type { WorksExecution } from "../execution/contract";
import type { RetentionPolicy } from "../execution/retention";
import type { ModuleLibrary } from "./library";
import { moduleDirectory } from "./local-library";
import type { SourceLimits } from "./source-admission";

const RECORD_FORMAT = "works.module-settings/1";

/**
 * A released Program's memory when neither its Manifest nor the user asks
 * for more: the Modules platform's own baseline, under the shared ceiling.
 */
export const PROGRAM_MEMORY_BYTES = 512 * 1024 * 1024;

/** The host policy a released Program starts under: its own defaults. */
export const PROGRAM_SETTINGS_POLICY = withModuleSettingDefaults({
  "resources.memoryBytes": PROGRAM_MEMORY_BYTES,
});

/** The values stay unchecked here; `parseModuleSettingValues` checks them. */
const recordSchema = z.object({
  format: z.literal(RECORD_FORMAT),
  values: z.unknown(),
});

/** What one authoring turn may use, from the Module's effective settings. */
export interface AuthoringTurnLimits {
  readonly deadlineMs: number;
  readonly maxSteps: number;
  readonly source: SourceLimits;
}

/** What a Module's sandbox starts with, from its effective settings. */
export interface SandboxResources {
  readonly cpus: number;
  readonly memoryBytes: number;
}

export interface ModuleSettingsOptions {
  /** Where user values are kept: one JSON file per Module. */
  readonly directory: string;
  readonly execution: Pick<
    WorksExecution,
    "configureModuleQueues" | "dispatch"
  >;
  /** Saved source, whose `foundry.module.json` declares requests/defaults. */
  readonly library: Pick<ModuleLibrary, "manifest">;
}

/**
 * Per-Module settings in Works state: user values by Module ID, resolved
 * against the Module's saved Manifest and the host ceilings. Changes are
 * `system` engine runs. Nothing here grants authority. Reads have no side
 * effects: they read the saved Manifest (never the Module folder) and leave
 * queues alone; queue concurrency is applied by {@link applyQueues} and by
 * a settings change.
 *
 * Effective settings are kept per Module, since every Artifact read asks for
 * them, until its settings change here or {@link applyQueues} is told its
 * Manifest may have changed.
 */
export class ModuleSettings {
  readonly #directory: string;
  /** Each Module's effective settings under the host's own policy. */
  readonly #effective = new Map<string, Promise<EffectiveModuleSettings>>();
  readonly #execution: ModuleSettingsOptions["execution"];
  readonly #library: ModuleSettingsOptions["library"];
  readonly #writes = new KeyedTurns<string>();

  constructor(options: ModuleSettingsOptions) {
    this.#directory = options.directory;
    this.#execution = options.execution;
    this.#library = options.library;
  }

  /** The user's values, effective values and unmet requirements. */
  async get(moduleId: string): Promise<ModuleSettingsView> {
    return view(
      moduleId,
      await this.user(moduleId),
      await this.#library.manifest(moduleId)
    );
  }

  /**
   * Replace the user's values. Keys must be settings, values within the
   * host ceilings and the Module's minimums; a value that cannot be met is
   * refused, never stored. Runs on the `system` queue, then applies the
   * Module's queue concurrency.
   */
  set(moduleId: string, values: unknown): Promise<ModuleSettingsView> {
    return this.#execution.dispatch(
      WORKS_TASKS.settings,
      { correlation: { moduleId } },
      (context) =>
        this.#writes.run(moduleId, async () => {
          const user = parseModuleSettingValues(values);
          const manifest = await this.#library.manifest(moduleId);
          const resolution = resolveModuleSettings({
            requests: moduleSettingRequests(manifest),
            user,
          });
          if (!resolution.ok) {
            throw new ModuleSettingsError(resolution.problems);
          }
          await writeRecord(this.#file(moduleId), user);
          this.#effective.delete(moduleId);
          this.#configureQueues(moduleId, resolution.effective);
          context.observe({
            data: { moduleId, values: { ...user } },
            kind: "result",
            type: OBSERVATION.settings,
          });
          return view(moduleId, user, manifest);
        })
    );
  }

  /** The values the user chose; none until they choose. */
  async user(moduleId: string): Promise<ModuleSettingValues> {
    const record = await readRecord(this.#file(moduleId));
    return record === undefined ? {} : parseModuleSettingValues(record.values);
  }

  /**
   * Effective settings for the Module's saved Manifest. Throws
   * `ModuleSettingsError` when a requirement is unmet.
   */
  effective(
    moduleId: string,
    policy?: ModuleSettingsHostPolicy
  ): Promise<EffectiveModuleSettings> {
    if (policy !== undefined) {
      return this.#resolve(moduleId, policy);
    }
    const kept = this.#effective.get(moduleId);
    if (kept) {
      return kept;
    }
    const resolving = this.#resolve(moduleId);
    this.#effective.set(moduleId, resolving);
    // A failure is not kept: the next read tries again.
    resolving.catch(() => {
      if (this.#effective.get(moduleId) === resolving) {
        this.#effective.delete(moduleId);
      }
    });
    return resolving;
  }

  async #resolve(
    moduleId: string,
    policy?: ModuleSettingsHostPolicy
  ): Promise<EffectiveModuleSettings> {
    return requireModuleSettings({
      requests: moduleSettingRequests(await this.#library.manifest(moduleId)),
      user: await this.user(moduleId),
      ...(policy === undefined ? {} : { policy }),
    });
  }

  /**
   * The Module's Manifest may have changed (or Works just started): read its
   * effective settings afresh and apply their queue concurrency to its
   * engine queues. Throws `ModuleSettingsError` when a requirement is unmet;
   * its queues then keep the engine's defaults.
   */
  async applyQueues(moduleId: string): Promise<void> {
    this.#effective.delete(moduleId);
    this.#configureQueues(moduleId, await this.effective(moduleId));
  }

  /** The limits of the Module's next authoring turn. */
  async authoringLimits(moduleId: string): Promise<AuthoringTurnLimits> {
    const effective = await this.effective(moduleId);
    return {
      deadlineMs: effective["authoring.deadline"],
      maxSteps: effective["authoring.maxSteps"],
      source: {
        maxBytes: effective["authoring.source.maxBytes"],
        maxFileCodeUnits: effective["authoring.source.maxFileCodeUnits"],
        maxFiles: effective["authoring.source.maxFiles"],
        maxPathCharacters: effective["authoring.source.maxPathCharacters"],
      },
    };
  }

  /**
   * How much the Module's Program may read per chunk and write per file,
   * and how many Artifacts one page of its scoped listing holds.
   */
  async artifactLimits(
    moduleId: string
  ): Promise<{ chunkBytes: number; maxFileBytes: number; pageSize: number }> {
    const effective = await this.effective(moduleId);
    return {
      chunkBytes: effective["artifacts.chunkBytes"],
      maxFileBytes: effective["artifacts.maxFileBytes"],
      pageSize: effective["explorer.pageSize"],
    };
  }

  /** How long, and how many, of the Module's settled runs the run store keeps. */
  async auditRetention(moduleId: string): Promise<RetentionPolicy> {
    const effective = await this.effective(moduleId);
    return {
      maxTerminalEntries: effective["audit.maxTerminalEntries"],
      retentionDays: effective["audit.retentionDays"],
    };
  }

  /** CPU and memory of the Module's shared authoring/build sandbox. */
  async sandboxResources(moduleId: string): Promise<SandboxResources> {
    return sandboxResources(await this.effective(moduleId));
  }

  #configureQueues(moduleId: string, effective: EffectiveModuleSettings) {
    this.#execution.configureModuleQueues(moduleId, {
      authoring: effective["queues.authoring.concurrency"],
      workflows: effective["queues.workflows.concurrency"],
    });
  }

  #file(moduleId: string) {
    return path.join(this.#directory, `${moduleDirectory(moduleId)}.json`);
  }
}

/** The sandbox capacity effective settings allocate. */
export function sandboxResources(
  effective: EffectiveModuleSettings
): SandboxResources {
  return {
    cpus: effective["resources.cpus"],
    memoryBytes: effective["resources.memoryBytes"],
  };
}

function view(
  moduleId: string,
  user: ModuleSettingValues,
  manifest: ModuleManifest | null
): ModuleSettingsView {
  const resolution = resolveModuleSettings({
    requests: moduleSettingRequests(manifest),
    user,
  });
  return {
    effective: resolution.ok ? { ...resolution.effective } : null,
    keys: MODULE_SETTING_KEYS.map((key) => {
      const host = MODULE_SETTING_HOST_POLICY[key];
      const program = PROGRAM_SETTINGS_POLICY[key].default;
      return {
        ceiling: host.ceiling,
        default: host.default,
        integer: host.integer,
        key,
        ...(program === host.default ? {} : { programDefault: program }),
        unit: host.unit,
      };
    }),
    moduleId,
    problems: resolution.ok ? [] : [...resolution.problems],
    user: { ...user },
  };
}

async function readRecord(
  file: string
): Promise<z.infer<typeof recordSchema> | undefined> {
  const value = await readJsonFile(file);
  if (value === undefined) {
    return;
  }
  const record = recordSchema.safeParse(value);
  if (!record.success) {
    throw new Error("Module settings were written by another Works version");
  }
  return record.data;
}

function writeRecord(file: string, values: ModuleSettingValues): Promise<void> {
  return writeFileAtomic(
    file,
    JSON.stringify({ format: RECORD_FORMAT, values }),
    { directoryMode: 0o700, mode: 0o600 }
  );
}
