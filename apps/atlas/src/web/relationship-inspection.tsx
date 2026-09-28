import type { ChangeEvent, MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { familyScenario, scenarioReview } from "./architecture";
import type { AtlasInternals } from "./internals";
import type { ResponsibilityOverlay } from "./responsibility-focus";
import { responsibilityFocus } from "./responsibility-focus";
import { ScenarioInspection } from "./scenario-inspection";
import { scenarioRoutes } from "./scenario-routes";

export function RelationshipInspection({
  data,
  from,
  to,
  onOverlay,
}: {
  data: AtlasInternals;
  from: string;
  to: string;
  onOverlay: (overlay: ResponsibilityOverlay | null) => void;
}) {
  const [scenarioId, setScenarioId] = useState("");
  const [familyId, setFamilyId] = useState("");
  const [progress, setProgress] = useState(0);
  const { architecture } = data;
  const relationship = data.responsibilities.relationships.find(
    (item) => item.from === from && item.to === to
  );
  const selected = architecture
    ? familyScenario(architecture, familyId, scenarioId)
    : undefined;
  const routes = useMemo(() => {
    const scenario = data.architecture
      ? familyScenario(data.architecture, familyId, scenarioId)
      : undefined;
    return scenario ? scenarioRoutes(data, scenario) : null;
  }, [data, scenarioId, familyId]);
  const overlay = useMemo(() => {
    const focus = responsibilityFocus(data, {
      id: from,
      kind: "region",
      relationship,
    });
    return routes && (routes.baseline.length > 0 || routes.proposed.length > 0)
      ? {
          ...focus,
          links: [],
          routes: {
            ...routes,
            progress,
            scopes: data.responsibilities.regions.map((region) => ({
              files: region.modules.flatMap(
                (module) => data.fileIds[module] ?? []
              ),
              id: region.id,
            })),
          },
        }
      : focus;
  }, [data, from, relationship, routes, progress]);
  useEffect(() => {
    onOverlay(overlay);
    return () => {
      onOverlay(null);
    };
  }, [overlay, onOverlay]);
  const selectScenario = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const { family } = event.currentTarget.dataset;
    if (!family) {
      return;
    }
    setScenarioId(event.currentTarget.value);
    setFamilyId(family);
    setProgress(0);
  }, []);
  const handleProgress = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setProgress(Number(event.target.value));
  }, []);
  if (!(architecture && relationship)) {
    return <p>No matching responsibility relationship in this report.</p>;
  }
  const regionName = (id: string) =>
    data.responsibilities.regions.find((region) => region.id === id)?.label ??
    id;
  const names = new Map(
    architecture.primitives.symbols.map((symbol) => [
      symbol.symbolId,
      symbol.name,
    ])
  );
  const families = architecture.review.families.filter(
    (family) =>
      family.subject.relationship?.from === from &&
      family.subject.relationship.to === to
  );
  return (
    <>
      <h3>
        {regionName(from)} → {regionName(to)}
      </h3>
      <p>
        {relationship.moduleEdges} current module edges ·{" "}
        {relationship.symbolFlow} symbols. Direction means imports from.
      </p>
      {!families.length && (
        <p>
          No reviewed alternatives for this relationship. Its dependencies
          remain inspectable without implying a defect.
        </p>
      )}
      {families.map((family) => (
        <details key={family.id} open>
          <summary>{family.disposition.replaceAll("-", " ")}</summary>
          {family.scenarios.map((id) => {
            const scenario = familyScenario(architecture, family.id, id);
            return scenario ? (
              <button
                aria-pressed={scenarioId === id && familyId === family.id}
                className="atlas-evidence-link"
                data-family={family.id}
                key={id}
                onClick={selectScenario}
                type="button"
                value={id}
              >
                {scenario.kind.replaceAll("-", " ")}
              </button>
            ) : null;
          })}
          {family.missingEvidence.length > 0 && (
            <ul>
              {family.missingEvidence.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </details>
      ))}
      {selected && (
        <>
          {routes && routes.proposed.length > 0 && (
            <label className="atlas-neighborhood-filter">
              <span>
                Trace proposed connections · {Math.round(progress * 100)}%
              </span>
              <input
                max="1"
                min="0"
                onChange={handleProgress}
                step="0.01"
                type="range"
                value={progress}
              />
            </label>
          )}
          {routes &&
            (routes.baseline.length > 0 || routes.proposed.length > 0) && (
              <p>
                Teal retains the affected consumers' current connections; amber
                shows the proposal. Open circles mean responsibility scopes, not
                destination files. Showing up to 64 routes per layer;{" "}
                {routes.baseline.length} current, {routes.proposed.length}{" "}
                proposed, {routes.unmapped} proposed endpoints unmapped.
                Connections are structural, not runtime traffic.
              </p>
            )}
          <ScenarioInspection
            names={names}
            review={scenarioReview(architecture, selected)}
            scenario={selected}
          />
        </>
      )}
    </>
  );
}
