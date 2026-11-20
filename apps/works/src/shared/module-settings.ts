import { z } from "zod";

export interface ModuleSettingsView {
  readonly effective: Readonly<Record<string, number | string>> | null;
  readonly keys: readonly ModuleSettingDescription[];
  readonly moduleId: string;
  readonly problems: readonly {
    readonly key: string;
    readonly message: string;
  }[];
  readonly user: Readonly<Record<string, number>>;
}

interface ModuleSettingDescription {
  readonly ceiling: number;
  readonly default: number;
  readonly integer: boolean;
  readonly key: string;
  readonly programDefault?: number;
  readonly unit: string;
}

const refusal = z.object({
  data: z.object({
    problems: z.array(z.object({ key: z.string(), message: z.string() })),
  }),
});

export function refusedSettings(
  error: unknown
): ModuleSettingsView["problems"] {
  const parsed = refusal.safeParse(error);
  return parsed.success ? parsed.data.data.problems : [];
}
