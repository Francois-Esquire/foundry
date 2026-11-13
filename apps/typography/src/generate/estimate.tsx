import { type CostEstimate, estimateHeadline } from "~/generation/cost";

interface EstimateProps {
  readonly estimate: CostEstimate;
}

/** The estimate of a model run: the figure, then everything it rests on. */
export function Estimate({ estimate }: EstimateProps) {
  return (
    <div className="ty-generate-stack" data-testid="estimate">
      <p className="ty-generate-estimate">
        <span className="ty-label ty-generate-tag">Estimate</span>{" "}
        <span data-calls={estimate.calls}>{estimateHeadline(estimate)}</span>
      </p>
      <ul
        aria-label="What the estimate rests on"
        className="ty-generate-assumptions"
      >
        {estimate.assumptions.map((assumption) => (
          <li key={assumption}>{assumption}</li>
        ))}
      </ul>
    </div>
  );
}
