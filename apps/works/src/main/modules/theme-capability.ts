import type { ModuleCapabilitySchema } from "@foundry/modules/gateway/types";
import {
  defineStream,
  noConstraints,
  object,
  portable,
  type WorksCapability,
} from "~/main/gateway/provider-kit";
import type { SystemTheme } from "~/main/system/theme";
import {
  isThemeAppearance,
  isThemeMode,
  THEME_APPEARANCES,
  THEME_MODES,
  type ThemeSnapshot,
} from "~/shared/theme";

export const THEME_CAPABILITY = "works.system.theme";

/** What the provider reads of main's theme. */
export type ThemeFeed = Pick<SystemTheme, "watch">;

const input: ModuleCapabilitySchema<Record<string, never>> = {
  description: portable({ additionalProperties: false, type: "object" }),
  parse(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length > 0
    ) {
      throw new Error("works.system.theme takes an empty input");
    }
    return {};
  },
};

const event: ModuleCapabilitySchema<ThemeSnapshot> = {
  description: object(
    {
      effective: portable({
        description: "The appearance in effect now.",
        enum: [...THEME_APPEARANCES],
        type: "string",
      }),
      mode: portable({
        description: "The appearance the user chose; auto follows the desktop.",
        enum: [...THEME_MODES],
        type: "string",
      }),
      revision: portable({
        description:
          "Advances with every change; a repeated revision is the same state.",
        type: "integer",
      }),
    },
    ["effective", "mode", "revision"]
  ),
  parse(value) {
    const snapshot = value as Partial<ThemeSnapshot> | null;
    if (
      !(
        isThemeMode(snapshot?.mode) &&
        isThemeAppearance(snapshot.effective) &&
        Number.isSafeInteger(snapshot.revision)
      )
    ) {
      throw new Error("Theme snapshot is invalid");
    }
    return {
      effective: snapshot.effective,
      mode: snapshot.mode,
      revision: snapshot.revision as number,
    };
  },
};

/**
 * `works.system.theme@1`: a read-only stream of the host theme, an initial
 * snapshot and then each change. Receiving it cannot change the preference.
 * Like every Capability it is delivered only under an approved Grant.
 */
export function themeCapability(theme: ThemeFeed): WorksCapability {
  return defineStream({
    capability: THEME_CAPABILITY,
    documentation:
      "The host theme: the chosen mode (auto, light or dark) and the appearance in effect, as a snapshot and then each change. Read-only.",
    event,
    input,
    invoke: (_input, context) => theme.watch(context.signal),
    policy: noConstraints(
      THEME_CAPABILITY,
      "read",
      "works.system.theme takes no constraints"
    ),
  });
}
