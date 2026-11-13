import { useMemo } from "react";
import { KEY_HINT } from "~/application/react";
import { sheetEstimate } from "~/generation/cost";
import type { StrategyOption } from "~/generation/strategies/offering";
import { SecretField } from "~/ui/controls/secret-field";
import { Estimate } from "../estimate";

const ruleSummary = (ruled: number, targets: number, weights: number) => {
  if (targets === 0) {
    return "Choose characters above to see which of them a rule can build.";
  }
  const built =
    ruled === targets
      ? `A rule can build ${targets === 1 ? "this target" : `all ${targets} targets`}`
      : `A rule can build ${ruled} of the ${targets} targets`;
  return `${built}, once for each of the ${weights} weights, from that weight's own base letters and marks.${
    ruled === targets
      ? ""
      : " The others have to be drawn, and the run says so for each."
  }`;
};

interface FamilyStrategyDetailsProps {
  readonly onKey: (key: string) => void;
  /** The strategy that is chosen. */
  readonly option: StrategyOption;
  readonly providerKey: string;
  /** How many of the targets a rule can build. */
  readonly ruled: number;
  readonly targets: number;
  readonly weights: number;
}

/** What the chosen strategy needs before it runs across weights, and what the run may cost. */
export function FamilyStrategyDetails({
  onKey,
  option,
  providerKey,
  ruled,
  targets,
  weights,
}: FamilyStrategyDetailsProps) {
  const estimate = useMemo(
    () =>
      sheetEstimate({
        faces: weights,
        kind: option.kind,
        model: option.model,
        targets,
      }),
    [option.kind, option.model, targets, weights]
  );
  if (option.kind === "recorded-run") {
    return null;
  }
  if (option.kind === "procedural") {
    return (
      <div className="ty-generate-stack">
        <p>{ruleSummary(ruled, targets, weights)}</p>
        <p data-testid="estimate">{estimate.assumptions.join(" ")}</p>
      </div>
    );
  }
  return (
    <div className="ty-generate-stack">
      <SecretField
        hint={KEY_HINT}
        label="fal API key"
        onChange={onKey}
        value={providerKey}
      />
      <Estimate estimate={estimate} />
    </div>
  );
}
