import { refuseUnfinishedApply } from "./apply-journal";
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
  const { reader, workspace } = await savedDataset(root, options.state);
  // An unfinished apply means the dataset may not describe the sources,
  // which outranks any violation: the check fails, saying what to run.
  refuseUnfinishedApply(workspace);
  const [manifest, lens] = await Promise.all([
    reader.manifest(),
    reader.lens("rules"),
  ]);
  return { generatedAt: manifest.generatedAt, lens, outcome: outcomeOf(lens) };
}
