import type { ReviewedRewiringScenario } from "../lib/architecture-review-types";
import type { InternalRewiringScenario } from "../lib/internal-rewiring-types";

export function ScenarioInspection({
  scenario,
  review,
  names,
}: {
  scenario: InternalRewiringScenario;
  review?: ReviewedRewiringScenario;
  names: Map<string, string>;
}) {
  const name = (id: string) => names.get(id) ?? id;
  return (
    <>
      <h4>{scenario.kind.replaceAll("-", " ")}</h4>
      <p>{review?.status.replaceAll("-", " ") ?? "Not reviewed"}.</p>
      <p>
        Target: {scenario.proposed.scope.replaceAll("-", " ")}. Exact
        destination remains deferred.
      </p>
      {scenario.proposed.candidateModules.length > 0 && (
        <details>
          <summary>Existing destination candidates</summary>
          <ul>
            {scenario.proposed.candidateModules.map((candidate) => (
              <li key={candidate.module}>
                {candidate.module}:{" "}
                {candidate.evidence
                  .map((value) => value.replaceAll("-", " "))
                  .join(", ")}
              </li>
            ))}
          </ul>
        </details>
      )}
      <details>
        <summary>Measured effects</summary>
        {review?.effects.map((effect) => (
          <details key={effect.dimension}>
            <summary>
              {effect.dimension.replaceAll("-", " ")} · {effect.certainty}
            </summary>
            <ul>
              {effect.measures.map((measure) => (
                <li key={measure.name}>
                  {measure.name}: {String(measure.before)} →{" "}
                  {String(measure.after)}
                </li>
              ))}
            </ul>
            {effect.conditions.length > 0 && (
              <ul>
                {effect.conditions.map((condition) => (
                  <li key={condition}>{condition}</li>
                ))}
              </ul>
            )}
          </details>
        ))}
      </details>
      {scenario.closure && (
        <details>
          <summary>
            {scenario.closure.required.length} required companions ·{" "}
            {scenario.closure.blockers.length} blockers
          </summary>
          <p>
            {scenario.closure.required.length} required companions ·{" "}
            {scenario.closure.optional.length} optional ·{" "}
            {scenario.closure.blockers.length} blockers
          </p>
          <ul>
            {scenario.closure.required.map((item) => (
              <li key={item.symbolId}>Required: {name(item.symbolId)}</li>
            ))}
            {scenario.closure.optional.map((item) => (
              <li key={item.symbolId}>
                Can stay and be imported: {name(item.symbolId)}
              </li>
            ))}
            {scenario.closure.blockers.map((item) => (
              <li key={item.symbolId}>
                Blocked by {name(item.symbolId)}:{" "}
                {item.reason.replaceAll("-", " ")}
              </li>
            ))}
          </ul>
          <p>
            A blocked modeled move is not proof that no refactoring could work.
          </p>
        </details>
      )}
      <details>
        <summary>Preserves in this scenario</summary>
        <ul>
          {scenario.preservations.map((value) => (
            <li key={value}>{value.replaceAll("-", " ")}</li>
          ))}
        </ul>
      </details>
      {review && review.preservation.required.length > 0 && (
        <details>
          <summary>Family preservation requirements</summary>
          <ul>
            {review.preservation.required.map((value) => (
              <li key={value}>
                {value.replaceAll("-", " ")} ·{" "}
                {review.preservation.missing.includes(value)
                  ? "not preserved by this alternative"
                  : "preserved"}
              </li>
            ))}
          </ul>
        </details>
      )}
      <details>
        <summary>Evidence and limits</summary>
        <p>Scenario: {scenario.id}</p>
        <p>Subject: {scenario.subject.key}</p>
        <ul>
          {[
            ...new Set([
              ...(scenario.subject.symbolIds ?? []),
              ...(scenario.proposed.separated?.flatMap(
                (group) => group.symbolIds
              ) ?? []),
            ]),
          ].map((id) => (
            <li key={id}>
              {name(id)} · {id}
            </li>
          ))}
        </ul>
        {scenario.proposed.remainder && (
          <p>
            {scenario.proposed.remainder.reduce(
              (count, group) => count + group.symbolIds.length,
              0
            )}{" "}
            declarations remain in {scenario.proposed.remainder.length} scope
            groups.
          </p>
        )}
        <ul>
          {scenario.rationale.facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
          {scenario.uncertainties.map((item, index) => (
            <li key={`${item.reason}:${index}`}>{item.detail}</li>
          ))}
        </ul>
        <p>
          Simulation describes the affected internal graph. It is not a verified
          source edit or a whole-workspace impact analysis.
        </p>
        <p>Comparison is within this scenario family, not a package ranking.</p>
      </details>
    </>
  );
}
