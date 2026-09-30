import type { MouseEvent, ToggleEvent } from "react";
import { useCallback, useState } from "react";
import type { AtlasSelection } from "../scene/scene";
import type { TradeRoute } from "../trade-routes";
import { leadingTrades } from "../trade-routes";
import type { AtlasData, AtlasRoute, Territory } from "../types";

export function TradePartners({
  data,
  territory,
  routes,
  onSelect,
}: {
  data: AtlasData;
  territory: Territory;
  routes: TradeRoute[];
  onSelect: (selection: AtlasSelection) => void;
}) {
  const trades = leadingTrades(data, territory.id);
  return (
    <details className="atlas-trade-index">
      <summary>Trading partners</summary>
      <p className="atlas-place-note">
        Routes connect consumers to suppliers. Counts are module dependencies,
        not live traffic.
      </p>
      {trades.map((dependency) => (
        <Partner
          data={data}
          dependency={dependency}
          key={`${dependency.from}:${dependency.to}`}
          onSelect={onSelect}
          route={routes.find(
            (r) =>
              r.dependency.from === dependency.from &&
              r.dependency.to === dependency.to
          )}
          territory={territory}
        />
      ))}
      {!trades.length && <p>No analyzed module-level trade routes.</p>}
    </details>
  );
}

function Partner({
  data,
  territory,
  dependency,
  route,
  onSelect,
}: {
  data: AtlasData;
  territory: Territory;
  dependency: AtlasRoute;
  route?: TradeRoute;
  onSelect: (selection: AtlasSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const consumer = data.territories.find((p) => p.id === dependency.from);
  const supplier = data.territories.find((p) => p.id === dependency.to);
  const importing = consumer?.id === territory.id;
  const partner = importing ? supplier : consumer;
  const sources = new Set(consumer?.files.map((f) => f.id));
  const targets = new Set(supplier?.files.map((f) => f.id));
  const edges = data.fileEdges.filter(
    (e) => sources.has(e.source) && targets.has(e.target)
  );
  const from = new Set(edges.map((e) => e.source)),
    to = new Set(edges.map((e) => e.target));
  const handleOpen = useCallback(
    (event: ToggleEvent<HTMLDetailsElement>) => {
      setOpen(event.currentTarget.open);
    },
    [setOpen]
  );
  const handleSelect = useCallback(() => {
    if (partner) {
      onSelect({ territory: partner });
    }
  }, [onSelect, partner]);
  const selectFile = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const selected = data.territories.find(
        (item) => item.id === event.currentTarget.dataset.territory
      );
      const file = selected?.files.find(
        (item) => item.id === event.currentTarget.value
      );
      if (selected && file) {
        onSelect({ file, territory: selected });
      }
    },
    [data, onSelect]
  );
  if (!(consumer && supplier && partner)) {
    return null;
  }
  return (
    <details onToggle={handleOpen}>
      <summary>
        {importing ? "Imports from" : "Supplies"} {partner.label} ·{" "}
        {dependency.weight}
      </summary>
      {open && (
        <>
          <p className="atlas-place-note">
            {route
              ? "Mapped route available."
              : "Route unavailable: no safe mapped path."}{" "}
            {edges.length
              ? `${from.size} consumer files · ${to.size} resource files.`
              : "No matched file endpoints. Route uses package geography."}
          </p>
          <button onClick={handleSelect} type="button">
            Visit {partner.label}
          </button>
          {(
            [
              [consumer, from, "Consumer files"],
              [supplier, to, "Resource files"],
            ] as const
          ).map(([p, members, label]) => (
            <details key={p.id}>
              <summary>
                {label} · {members.size}
              </summary>
              {p.files
                .filter((f) => members.has(f.id))
                .map((file) => (
                  <button
                    data-territory={p.id}
                    key={file.id}
                    onClick={selectFile}
                    title={file.path}
                    type="button"
                    value={file.id}
                  >
                    {file.path}
                  </button>
                ))}
            </details>
          ))}
        </>
      )}
    </details>
  );
}
