/** A set of layout feature choices as the browser is told them. */
import type { FeatureChoices } from "~/typeface/layout-features";

/** The choices as a CSS `font-feature-settings` value, for example `"liga" 0`. */
export const fontFeatureSettings = (choices: FeatureChoices) =>
  Object.keys(choices)
    .sort()
    .map((tag) => `"${tag}" ${choices[tag] ? 1 : 0}`)
    .join(", ") || "normal";
