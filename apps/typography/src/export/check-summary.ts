import { count } from "~/lib/count";
import type {
  DerivedFontCheck,
  DerivedFontReport,
} from "~/packaging/validation";
/** "6 of 6 checks passed", and never a pass for a check that did not run. */
export const summariseReport = ({ checks }: DerivedFontReport) => {
  const numberOf = (outcome: DerivedFontCheck["outcome"]) =>
    checks.filter((check) => check.outcome === outcome).length;
  const failed = numberOf("fail");
  const skipped = numberOf("not-run");
  return [
    `${numberOf("pass")} of ${count(checks.length, "check")} passed`,
    failed > 0 ? `${failed} failed` : undefined,
    skipped > 0 ? `${skipped} did not run` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
};
