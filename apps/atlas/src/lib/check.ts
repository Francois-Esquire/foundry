import { savedDataset } from "./dataset-files";
import type { Rules } from "./lenses/rules-types";

// `atlas check`: the workspace's rules against the saved dataset, as the
// scan's rules lens left them. It reads only the dataset: no configuration
// runs, nothing is analyzed, and a rules-only edit takes a warm scan to show.

/**
 * What the check found. `incomplete`: a `require` rule could not be checked
 * in a package that failed analysis, which outranks any violation, since
 * the places it could not see may break it too.
 */
type CheckOutcome = "clean" | "violations" | "incomplete";

export interface CheckResult {
  /** The checked dataset's manifest `generatedAt`. */
  generatedAt: string;
  /** The saved rules lens, as `atlas lens rules` prints it. */
  lens: Rules;
  outcome: CheckOutcome;
}

function outcomeOf(lens: Rules): CheckOutcome {
  if (lens.missing.length > 0) {
    return "incomplete";
  }
  return lens.violations.length > 0 ? "violations" : "clean";
}

/** Reads the saved dataset's rules lens; a dataset saved before the lens existed fails. */
export async function check(
  root: string,
  options: { state?: string | undefined } = {}
): Promise<CheckResult> {
  const { reader } = await savedDataset(root, options.state);
  const [manifest, lens] = await Promise.all([
    reader.manifest(),
    reader.lens("rules"),
  ]);
  // 3.5's apply journal (`apply/journal.json` in the workspace's state
  // directory) will be read here: a journal means the dataset no longer
  // describes the sources, and the check reports it before any violation.
  return { generatedAt: manifest.generatedAt, lens, outcome: outcomeOf(lens) };
}
