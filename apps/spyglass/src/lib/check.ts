import { refuseUnfinishedApply } from "./apply-journal";
import { savedDataset } from "./dataset-files";
import type { Rules } from "./lenses/rules-types";

type CheckOutcome = "clean" | "violations" | "incomplete";

export interface CheckResult {
  generatedAt: string;
  lens: Rules;
  outcome: CheckOutcome;
}

function outcomeOf(lens: Rules): CheckOutcome {
  if (lens.missing.length > 0) {
    return "incomplete";
  }
  return lens.violations.length > 0 ? "violations" : "clean";
}

export async function check(
  root: string,
  options: { state?: string | undefined } = {}
): Promise<CheckResult> {
  const { reader, workspace } = await savedDataset(root, options.state);
  refuseUnfinishedApply(workspace);
  const [manifest, lens] = await Promise.all([
    reader.manifest(),
    reader.lens("rules"),
  ]);
  return { generatedAt: manifest.generatedAt, lens, outcome: outcomeOf(lens) };
}
