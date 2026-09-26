import { useEffect } from "react";
import { compositionGroups, scenarioReview } from "./architecture";
import type { AtlasInternals } from "./internals";
import type { ResponsibilityOverlay } from "./responsibility-focus";
import { ScenarioInspection } from "./ScenarioInspection";

export function UnmappedModuleInspection({
  data,
  module,
  onOverlay,
}: {
  data: AtlasInternals;
  module: string;
  onOverlay: (overlay: ResponsibilityOverlay | null) => void;
}) {
  useEffect(() => {
    onOverlay(null);
  }, [onOverlay]);
  const architecture = data.architecture;
  if (!architecture) {
    return null;
  }
  const groups = compositionGroups(architecture.primitives.symbols, module);
  const names = new Map(
    architecture.primitives.symbols.map((symbol) => [
      symbol.symbolId,
      symbol.name,
    ])
  );
  const scenarios = architecture.rewiring.scenarios.filter(
    (scenario) => scenario.subject.module === module
  );
  return (
    <section aria-label="Unmapped module evidence">
      <h3>{module}</h3>
      <p>
        Analyzed, but absent from the map survey. Evidence is available here; no
        settlement or tracing position is invented. Refresh the semantic survey
        to include this file in the geography.
      </p>
      {groups.map((group) => (
        <details key={group.id}>
          <summary>
            {data.responsibilities.regions.find(
              (region) => region.id === group.id
            )?.label ?? group.id.replaceAll("-", " ")}
            {" · "}
            {group.symbols.length} declarations
          </summary>
          <ul>
            {group.symbols.map((symbol) => (
              <li key={symbol.symbolId}>
                {symbol.name} · {symbol.roles.join(", ")} ·{" "}
                {symbol.evidence.scope} scope evidence
                {!symbol.exported && " · private"}
              </li>
            ))}
          </ul>
        </details>
      ))}
      {scenarios.map((scenario) => (
        <details key={`${scenario.subject.key}:${scenario.id}`}>
          <summary>
            {scenario.kind.replaceAll("-", " ")} · {scenario.id}
          </summary>
          <ScenarioInspection
            names={names}
            review={scenarioReview(architecture, scenario)}
            scenario={scenario}
          />
        </details>
      ))}
      {!scenarios.length && <p>No modeled alternatives for this module.</p>}
    </section>
  );
}
