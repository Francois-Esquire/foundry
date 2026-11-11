/** Putting a script extension into its face. */
import type { Change } from "~/typeface/changes";
import type { Outcome } from "~/workspace/notices";
import type { Workspace } from "~/workspace/workspace";

/**
 * Adds a script extension to its face whole, as one revision. Its layout
 * rules name every glyph, so no part of it can go in without the rest.
 * `script` is the plan's name for the script, for example Devanagari.
 */
export const addExtension = (
  workspace: Pick<Workspace, "apply">,
  script: string,
  changes: readonly Change[]
): Outcome => workspace.apply(`Add a ${script} subset`, changes);
