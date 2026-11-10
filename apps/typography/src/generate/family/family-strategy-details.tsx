import { useMemo } from "react";
import type { CostEstimate } from "~/generation/family/cost";
import { SecretField } from "../secret-field";
import type { StrategyOption } from "../strategies";
import { KEY_HINT } from "../strategy-details";
import { estimateHeadline, familyEstimate } from "./family-cost";

interface EstimateProps {
  readonly estimate: CostEstimate;
}

/** The estimate of a model run across weights: the figure, then everything it rests on. */
function Estimate({ estimate }: EstimateProps) {
  return (
    <div className="ty-generate-stack" data-testid="family-estimate">
      <p className="ty-generate-estimate">
        <span className="ty-label ty-generate-tag">Estimate</span>{" "}
        <span data-calls={estimate.calls}>{estimateHeadline(estimate)}</span>
      </p>
      <ul
        aria-label="What the estimate rests on"
        className="ty-family-assumptions"
      >
        {estimate.assumptions.map((assumption) => (
          <li key={assumption}>{assumption}</li>
        ))}
      </ul>
    </div>
  );
}

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
      familyEstimate({
        kind: option.kind,
        model: option.model,
        targets,
        weights,
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
        <p data-testid="family-estimate">{estimate.assumptions.join(" ")}</p>
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
