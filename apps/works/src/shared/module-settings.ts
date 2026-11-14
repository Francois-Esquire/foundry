import { z } from "zod";

/**
 * One Module's settings as main reports them: the values the user chose,
 * the effective values the host applies, and why requirements cannot be
 * met. Settings are limits and preferences; Grants (network, broader
 * Artifact access, host operations) are managed in Access, not here.
 */
export interface ModuleSettingsView {
  /** `null` while any requirement is unmet; `problems` says which. */
  readonly effective: Readonly<Record<string, number | string>> | null;
  /** What each setting may be on this host. */
  readonly keys: readonly ModuleSettingDescription[];
  readonly moduleId: string;
  readonly problems: readonly {
    readonly key: string;
    readonly message: string;
  }[];
  /** Values the user chose, by dot-notation key. */
  readonly user: Readonly<Record<string, number>>;
}

interface ModuleSettingDescription {
  readonly ceiling: number;
  /** The Module's authoring and build sandbox default. */
  readonly default: number;
  readonly integer: boolean;
  readonly key: string;
  /** A released app's default, where it differs from `default`. */
  readonly programDefault?: number;
  readonly unit: string;
}

const refusal = z.object({
  data: z.object({
    problems: z.array(z.object({ key: z.string(), message: z.string() })),
  }),
});

/**
 * Why main refused a settings save, from the RPC error's `data`; empty for
 * any other failure.
 */
export function refusedSettings(
  error: unknown
): ModuleSettingsView["problems"] {
  const parsed = refusal.safeParse(error);
  return parsed.success ? parsed.data.data.problems : [];
}
