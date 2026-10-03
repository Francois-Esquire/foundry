import { type ReactNode, useCallback } from "react";
import {
  featureText,
  type NaturalFeature,
} from "../natural-feature-inspection";
import type { NaturalFeatures, Stream } from "../natural-features";
import type { AtlasSelection } from "../scene/scene";
import type { Territory } from "../types";

function streamFeature(stream: Stream): NaturalFeature {
  return {
    kind: "river",
    river: {
      moduleEdges: stream.moduleEdges,
      points: stream.points,
      streams: [stream],
      width: stream.width,
    },
  };
}

export function NaturalFeaturePanel({
  features,
  selection,
  hover,
  onSelect,
}: {
  features: NaturalFeatures;
  selection: AtlasSelection;
  hover: AtlasSelection | null;
  onSelect: (selection: AtlasSelection) => void;
}) {
  const landmark = features.landmarks.find(
    (item) => item.file.id === (hover?.file?.id ?? selection.file?.id)
  );
  const feature =
    hover?.feature ??
    selection.feature ??
    (landmark ? { kind: "landmark" as const, landmark } : undefined);
  const { territory } = selection;
  return (
    <section aria-label="Natural features" className="atlas-natural-features">
      {feature && (
        <FeatureEvidence
          feature={feature}
          onSelect={onSelect}
          territory={territory}
        />
      )}
      {features.changeNote && <p>{features.changeNote}</p>}
      <details>
        <summary>Explore natural features</summary>
        <p>
          {features.landmarks.length} structural and change records ·{" "}
          {features.marshes.length} unresolved modules ·{" "}
          {features.streams.length} mapped relationships
        </p>
        <div className="atlas-feature-index">
          {features.landmarks.map((item) => (
            <PlaceButton
              key={item.file.id}
              onSelect={onSelect}
              value={{
                feature: { kind: "landmark", landmark: item },
                territory,
              }}
            >
              {item.file.path}
            </PlaceButton>
          ))}
          {features.streams.map((stream) => (
            <PlaceButton
              key={`${stream.from}:${stream.to}`}
              onSelect={onSelect}
              value={{ feature: streamFeature(stream), territory }}
            >
              {stream.consumerLabel} imports from {stream.supplierLabel} ·{" "}
              {stream.moduleEdges}
            </PlaceButton>
          ))}
          {features.marshes.map((marsh) => (
            <PlaceButton
              key={marsh.region.id}
              onSelect={onSelect}
              value={{ feature: { kind: "marsh", marsh }, territory }}
            >
              Marsh · {marsh.region.label}
            </PlaceButton>
          ))}
        </div>
      </details>
    </section>
  );
}

function FeatureEvidence({
  feature,
  territory,
  onSelect,
}: {
  feature: NaturalFeature;
  territory: Territory;
  onSelect: (selection: AtlasSelection) => void;
}) {
  const text = featureText(feature);
  return (
    <div className="atlas-feature-evidence">
      <h3>{text.title}</h3>
      <p>{text.detail}</p>
      {feature.kind === "landmark" && (
        <>
          <p>
            This evidence describes the file at its existing mark. Terrain
            height follows file concentration.
          </p>
          <PlaceButton
            onSelect={onSelect}
            value={{ file: feature.landmark.file, territory }}
          >
            Inspect file
          </PlaceButton>
        </>
      )}
      {feature.kind === "river" && (
        <>
          <p>
            {feature.river.streams.length > 1
              ? "This trunk carries the following relationships. Width adds their module edges."
              : "This is an aggregate relationship between responsibilities, not a trace of every file import."}
          </p>
          {feature.river.streams.map((stream) => (
            <div
              className="atlas-stream-evidence"
              key={`${stream.from}:${stream.to}`}
            >
              <h4>
                {stream.consumerLabel} imports from {stream.supplierLabel}
              </h4>
              <p>
                {stream.moduleEdges} module{" "}
                {stream.moduleEdges === 1 ? "edge" : "edges"}
              </p>
              <p>
                {stream.symbols.length
                  ? `Crossing symbols: ${stream.symbols.map((symbol) => `${symbol.name} (${symbol.importSites} import ${symbol.importSites === 1 ? "site" : "sites"})`).join(", ")}.`
                  : "No dominant crossing symbols recorded."}
              </p>
              <PlaceButton
                onSelect={onSelect}
                value={{ file: stream.spring, territory }}
              >
                Supplier · {stream.spring.path}
              </PlaceButton>
              <PlaceButton
                onSelect={onSelect}
                value={{ file: stream.mouth, territory }}
              >
                Consumer mouth · {stream.mouth.path}
              </PlaceButton>
            </div>
          ))}
        </>
      )}
      {feature.kind === "marsh" && (
        <>
          <p>
            Reed density is reduced where marks crowd together. Every unresolved
            module remains available here.
          </p>
          <PlaceButton
            onSelect={onSelect}
            value={{ regionId: feature.marsh.region.id, territory }}
          >
            Inspect unresolved belonging
          </PlaceButton>
        </>
      )}
    </div>
  );
}

function PlaceButton({
  children,
  onSelect,
  value,
}: {
  children: ReactNode;
  onSelect: (selection: AtlasSelection) => void;
  value: AtlasSelection;
}) {
  const select = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <button onClick={select} type="button">
      {children}
    </button>
  );
}
