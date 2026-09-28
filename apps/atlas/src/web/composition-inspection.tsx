import type { ChangeEvent, MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CompositionEvidence } from "../lib/internal-rewiring-types";
import type { PrimitiveModuleFinding } from "../lib/primitive-convention-types";
import {
  type AtlasArchitecture,
  compositionGroups,
  familyScenario,
  scenarioReview,
} from "./architecture";
import type { CompositionArrangement } from "./composition-layout";
import {
  layoutComposition,
  layoutScenarioComposition,
} from "./composition-layout";
import { compositionMotionFits } from "./composition-motion";
import { fitComposition } from "./composition-placement";
import type { AtlasInternals } from "./internals";
import type { ResponsibilityOverlay } from "./responsibility-focus";
import { ScenarioInspection } from "./scenario-inspection";
import { scenarioRoutes } from "./scenario-routes";
import type { AtlasFile, AtlasSymbol, Territory } from "./types";

export function CompositionInspection({
  data,
  module,
  file,
  territory,
  onOverlay,
  symbol,
  onSymbol,
}: {
  data: AtlasInternals;
  module: string;
  file: AtlasFile;
  territory: Territory;
  onOverlay: (value: ResponsibilityOverlay | null) => void;
  symbol?: AtlasSymbol;
  onSymbol: (symbol?: AtlasSymbol) => void;
}) {
  const [groupId, setGroupId] = useState("");
  const [tracedSymbol, setTracedSymbol] = useState("");
  const [scenarioId, setScenarioId] = useState("");
  const [familyId, setFamilyId] = useState("");
  const [hints, setHints] = useState(false);
  const [trace, setTrace] = useState(0);
  const [arrangement, setArrangement] =
    useState<CompositionArrangement>("rows");
  const { architecture } = data;
  const groups = useMemo(
    () => compositionGroups(architecture?.primitives.symbols ?? [], module),
    [architecture, module]
  );
  const scenario = architecture
    ? familyScenario(architecture, familyId, scenarioId)
    : undefined;
  const marks = useMemo(
    () => layoutComposition(groups, arrangement),
    [groups, arrangement]
  );
  const fitted = useMemo(
    () => fitComposition(marks, territory, file),
    [marks, territory, file]
  );
  const proposedMarks = useMemo(
    () => (scenario ? layoutScenarioComposition(marks, scenario) : []),
    [marks, scenario]
  );
  const proposedFit = useMemo(
    () =>
      fitComposition(
        proposedMarks,
        territory,
        file,
        fitted.marks.map((mark) => ({
          x: file.x + mark.x,
          y: file.y + mark.y,
        }))
      ),
    [proposedMarks, territory, file, fitted]
  );
  const routePreview = useMemo(
    () => (scenario ? scenarioRoutes(data, scenario) : null),
    [data, scenario]
  );
  const stationary = useMemo(
    () => ({
      reveal: fitted.marks
        .filter(
          (mark) =>
            !compositionMotionFits(
              [file, { x: file.x + mark.x, y: file.y + mark.y }],
              territory.coast
            )
        )
        .map((mark) => mark.id),
      trace: proposedFit.marks
        .filter((mark) => {
          const original = fitted.marks.find((item) => item.id === mark.id);
          return !(
            original &&
            compositionMotionFits(
              [
                file,
                { x: file.x + original.x, y: file.y + original.y },
                { x: file.x + mark.x, y: file.y + mark.y },
              ],
              territory.coast
            )
          );
        })
        .map((mark) => mark.id),
    }),
    [fitted, proposedFit, file, territory.coast]
  );
  const overlay = useMemo((): ResponsibilityOverlay => {
    const symbols = new Set(
      groups
        .filter((group) => symbol !== undefined || group.id === groupId)
        .flatMap((group) =>
          group.symbols
            .filter((item) => !symbol || item.symbolId === symbol.id)
            .map((symbolEntry4) => symbolEntry4.symbolId)
        )
    );
    const consumers = [
      ...new Set(
        data.locality.symbols
          .filter((symbolEntry3) => symbols.has(symbolEntry3.symbolId))
          .flatMap((symbolEntry5) => symbolEntry5.consumerModules)
      ),
    ];
    const related = consumers.flatMap((id) => data.fileIds[id] ?? []);
    const tracing = symbol ? tracedSymbol === symbol.id : groupId !== "";
    return {
      composition: {
        active: [...symbols],
        fileId: file.id,
        marks: fitted.marks,
        names: Object.fromEntries(
          groups.flatMap((group) =>
            group.symbols.map((item) => [item.symbolId, item.name])
          )
        ),
        stationary: stationary.reveal,
      },
      hints: resolveHints(hints, architecture, data),
      links: (tracing ? related : [])
        .slice(0, 24)
        .map((source) => ({ source, target: file.id })),
      members: [file.id],
      pathDisagreement: [],
      related: tracing ? related : [],
      territoryId: data.topology.package.id,
      totalLinks: related.length,
      unresolved: [],
      ...(routePreview
        ? {
            routes: {
              ...routePreview,
              progress: trace,
              scopes: data.responsibilities.regions.map((region) => ({
                files: region.modules.flatMap(
                  (moduleId) => data.fileIds[moduleId] ?? []
                ),
                id: region.id,
              })),
            },
          }
        : {}),
      ...(scenario && trace > 0
        ? {
            trace: {
              blockers:
                scenario.closure?.blockers.map((item) => item.symbolId) ?? [],
              marks: proposedFit.marks,
              progress: trace,
              stationary: stationary.trace,
            },
          }
        : {}),
    };
  }, [
    architecture,
    data,
    file.id,
    groupId,
    groups,
    hints,
    scenario,
    trace,
    fitted,
    proposedFit,
    routePreview,
    symbol,
    stationary,
    tracedSymbol,
  ]);
  useEffect(() => {
    onOverlay(overlay);
    return () => {
      onOverlay(null);
    };
  }, [overlay, onOverlay]);
  const names = new Map(
    architecture?.primitives.symbols.map((symbolEntry2) => [
      symbolEntry2.symbolId,
      symbolEntry2.name,
    ])
  );
  const finding = architecture?.primitives.modules.find(
    (item) => item.module === module
  );
  const selectedSymbol = architecture?.primitives.symbols.find(
    (item) => item.symbolId === symbol?.id && item.declaration.module === module
  );
  const composition = architecture?.rewiring.composition.find(
    (item) => item.module === module
  );
  const families =
    architecture?.review.families.filter(
      (family) => family.subject.module === module
    ) ?? [];
  const handleTracedSymbol = useCallback(() => {
    if (!selectedSymbol) {
      return;
    }
    setTracedSymbol(
      tracedSymbol === selectedSymbol.symbolId ? "" : selectedSymbol.symbolId
    );
  }, [selectedSymbol, setTracedSymbol, tracedSymbol]);
  const handleSymbol = useCallback(() => {
    onSymbol();
  }, [onSymbol]);
  const handleArrangement = useCallback(
    (event: ChangeEvent<HTMLSelectElement, HTMLSelectElement>) => {
      setArrangement(event.target.value === "clusters" ? "clusters" : "rows");
      setTrace(0);
    },
    [setArrangement, setTrace]
  );
  const handleHints = useCallback(
    (event: ChangeEvent<HTMLInputElement, HTMLInputElement>) => {
      setHints(event.target.checked);
    },
    [setHints]
  );
  const handleTrace = useCallback(
    (event: ChangeEvent<HTMLInputElement, HTMLInputElement>) => {
      setTrace(Number(event.target.value));
    },
    [setTrace]
  );
  const traceGroup = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const id = event.currentTarget.value;
      onSymbol();
      setGroupId((current) => (current === id ? "" : id));
    },
    [onSymbol]
  );
  const selectDeclaration = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const entry = architecture?.primitives.symbols.find(
        (item) => item.symbolId === event.currentTarget.value
      );
      if (entry) {
        onSymbol({ id: entry.symbolId, name: entry.name });
      }
    },
    [architecture, onSymbol]
  );
  const selectScenario = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const { family } = event.currentTarget.dataset;
    if (!family) {
      return;
    }
    setScenarioId(event.currentTarget.value);
    setFamilyId(family);
    setTrace(0);
  }, []);
  if (!architecture) {
    return null;
  }
  return (
    <>
      <h3>{module.split("/").at(-1)}</h3>
      {selectedSymbol && (
        <section aria-label="Selected declaration">
          <h4>{selectedSymbol.name}</h4>
          <p>
            {selectedSymbol.roles.join(", ")} ·{" "}
            {selectedSymbol.scope.replaceAll("-", " ")} ·{" "}
            {selectedSymbol.evidence.scope} scope evidence
          </p>
          <button
            aria-pressed={tracedSymbol === selectedSymbol.symbolId}
            className="atlas-evidence-link"
            onClick={handleTracedSymbol}
            type="button"
          >
            {tracedSymbol === selectedSymbol.symbolId
              ? "Hide consumers"
              : "Trace consumers"}
          </button>
          <details>
            <summary>Declaration details</summary>
            <p>
              {selectedSymbol.consumers.modules} internal consumer modules in{" "}
              {selectedSymbol.consumers.responsibilities.length} placed
              responsibilities. {selectedSymbol.consumers.unresolvedModules}{" "}
              consumer modules unresolved.
            </p>
            <ul>
              {selectedSymbol.limitations.map((limit) => (
                <li key={limit}>{limit.replaceAll("-", " ")}</li>
              ))}
            </ul>
          </details>
          <button
            className="atlas-evidence-link"
            onClick={handleSymbol}
            type="button"
          >
            Return to composition
          </button>
        </section>
      )}
      <p>{resolveCompositionInspection(composition, finding)}</p>
      <p>
        {groups.reduce((count, group) => count + group.symbols.length, 0)}{" "}
        declarations · {groups.length} scope groups. Select a mark to inspect
        it.
      </p>
      <details>
        <summary>Drawing details</summary>
        <label className="atlas-neighborhood-filter">
          <span>Composition arrangement</span>
          <select onChange={handleArrangement} value={arrangement}>
            <option value="rows">Rows</option>
            <option value="clusters">Compact clusters</option>
          </select>
          <span>
            Same declarations and belonging; a different drawing, not an
            architectural alternative.
          </span>
        </label>
        <p>
          Consumer traces include re-export-mediated use, not just direct
          imports. At most 24 mapped consumers are drawn; the symbol evidence
          retains the full scope.
        </p>
      </details>
      {fitted.unplaced.length > 0 && (
        <p>
          {fitted.unplaced.length} declarations exceed this local drawing's land
          or spacing capacity. All remain listed below. This is a display limit,
          not architectural overpacking.
        </p>
      )}
      {!groups.length && (
        <p>
          No classified source declarations. Context files are not forced into
          responsibility groups.
        </p>
      )}
      <details>
        <summary>Browse declarations</summary>
        {groups.map((group) => (
          <details key={group.id}>
            <summary>
              {data.responsibilities.regions.find(
                (region) => region.id === group.id
              )?.label ?? group.id.replaceAll("-", " ")}{" "}
              · {group.symbols.length}
            </summary>
            <button
              aria-pressed={groupId === group.id}
              className="atlas-evidence-link"
              onClick={traceGroup}
              type="button"
              value={group.id}
            >
              Trace this group's consumers
            </button>
            <ul>
              {group.symbols.map((symbolEntry) => (
                <li key={symbolEntry.symbolId}>
                  <button
                    aria-pressed={
                      selectedSymbol?.symbolId === symbolEntry.symbolId
                    }
                    className="atlas-evidence-link"
                    onClick={selectDeclaration}
                    type="button"
                    value={symbolEntry.symbolId}
                  >
                    {symbolEntry.name}
                  </button>
                  {symbolEntry.roles.join(", ")} · {symbolEntry.evidence.scope}{" "}
                  scope evidence
                  {!symbolEntry.exported && " · private"}
                </li>
              ))}
            </ul>
          </details>
        ))}
      </details>
      <details>
        <summary>Compare alternatives</summary>
        <label>
          <input checked={hints} onChange={handleHints} type="checkbox" /> Show
          alternative investigations
        </label>
        <p>
          Open amber marks indicate credible or uncertain alternatives, not
          defects or recommendations.
        </p>
        {families.map((family) => (
          <details key={family.id}>
            <summary>
              {(family.subject.symbolIds ?? [])
                .slice(0, 2)
                .map((id) => names.get(id) ?? id)
                .join(", ") || family.subject.kind.replaceAll("-", " ")}{" "}
              · {family.disposition.replaceAll("-", " ")}
            </summary>
            {family.scenarios.map((id) => {
              const option = familyScenario(architecture, family.id, id);
              return (
                option && (
                  <button
                    aria-pressed={scenarioId === id && familyId === family.id}
                    className="atlas-evidence-link"
                    data-family={family.id}
                    key={id}
                    onClick={selectScenario}
                    type="button"
                    value={id}
                  >
                    {option.kind.replaceAll("-", " ")}
                    {option.proposed.separated &&
                      ` · ${option.proposed.separated.length} groups, ${option.proposed.separated.reduce((count, group) => count + group.symbolIds.length, 0)} declarations`}
                    {option.proposed.responsibility &&
                      ` · ${data.responsibilities.regions.find((region) => region.id === option.proposed.responsibility)?.label ?? option.proposed.responsibility}`}
                  </button>
                )
              );
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
        {!families.length && (
          <p>
            No reviewed alternatives for this file. Absence of a scenario is not
            a quality verdict.
          </p>
        )}
        {scenario && (
          <>
            {proposedMarks.length > 0 ||
            (routePreview?.proposed.length ?? 0) > 0 ? (
              <label className="atlas-neighborhood-filter">
                <span>Tracing paper · {Math.round(trace * 100)}%</span>
                <input
                  max="1"
                  min="0"
                  onChange={handleTrace}
                  step="0.01"
                  type="range"
                  value={trace}
                />
                <span>
                  Illustrative separation, not a destination or timeline. Rust
                  marks show modeled blockers.
                </span>
              </label>
            ) : null}
            {routePreview && routePreview.proposed.length > 0 && (
              <p>
                Teal shows affected consumers' current connections, amber the
                proposal. Open-circle endpoints indicate scopes, not exact
                files. Up to 64 routes per layer; {routePreview.baseline.length}{" "}
                current and {routePreview.proposed.length} proposed.{" "}
                {routePreview.unmapped} proposed endpoints are unmapped.
              </p>
            )}
            {proposedFit.unplaced.length > 0 && (
              <p>
                {proposedFit.unplaced.length} proposed marks have no room beside
                the current drawing. Their scenario evidence remains below; no
                destination is invented.
              </p>
            )}
            <ScenarioInspection
              names={names}
              review={scenarioReview(architecture, scenario)}
              scenario={scenario}
            />
          </>
        )}
      </details>
    </>
  );
}

function resolveCompositionInspection(
  composition: CompositionEvidence | undefined,
  finding: PrimitiveModuleFinding | undefined
): React.ReactNode {
  if (composition?.compositionRoot) {
    return "Composition junction. Its wiring role must be preserved.";
  }
  if (finding?.shapes.length) {
    return finding.shapes.map((value) => value.replaceAll("-", " ")).join(", ");
  }
  return "Source settlement";
}

function resolveHints(
  hints: boolean,
  architecture: AtlasArchitecture | undefined,
  data: AtlasInternals
): string[] | undefined {
  if (hints) {
    return [
      ...new Set(
        architecture?.review.subjects
          .filter((subject) =>
            subject.nondominatedScenarios.some((id) =>
              architecture.review.scenarios.some(
                (value) =>
                  value.scenarioId === id &&
                  value.familyId === subject.subject.key &&
                  ["credible", "uncertain"].includes(value.status)
              )
            )
          )
          .flatMap((subject) =>
            subject.subject.kind === "module"
              ? (data.fileIds[subject.subject.key] ?? [])
              : []
          ) ?? []
      ),
    ];
  }
  return [];
}
