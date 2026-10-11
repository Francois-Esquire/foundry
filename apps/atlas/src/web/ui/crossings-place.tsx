import { type CrossingPair, crossingsOf } from "../crossings";
import { type AtlasData, islandName, type Territory } from "../types";

/** A pair's declarations as written: "dependencies ^1.0.0, devDependencies ^2.0.0". */
function declarations(pair: CrossingPair): string {
  return pair.declared
    .map((crossing) => `${crossing.kind} ${crossing.range}`)
    .join(", ");
}

/**
 * The selected island's crossings in Place: the packages of other
 * workspaces it declares a dependency on, and those that declare one on it,
 * one line for each pair with every declaration between the two. Plain
 * text: a crossing is drawn on the map but is not a route, and cannot be
 * selected. Nothing for an island with none, so nothing for a single
 * workspace.
 */
export function CrossingsPlace({
  data,
  territory,
}: {
  data: Pick<AtlasData, "crossings" | "frames" | "territories">;
  territory: Territory;
}) {
  const { incoming, outgoing } = crossingsOf(data, territory.id);
  if (!(incoming.length || outgoing.length)) {
    return null;
  }
  const name = (id: string) => {
    const island = data.territories.find((item) => item.id === id);
    return island ? islandName(data, island) : id;
  };
  return (
    <section aria-label="Crossings" className="atlas-place-crossings">
      <h3>Across workspaces</h3>
      <p className="atlas-place-note">
        Declared dependencies between workspaces, one line on the map for each
        pair of packages. They are not routes: no imports are recorded across
        workspaces, and a crossing cannot be selected.
      </p>
      <ul>
        {outgoing.map((pair) => (
          <li key={pair.to}>
            Depends on {name(pair.to)}: {declarations(pair)}
          </li>
        ))}
        {incoming.map((pair) => (
          <li key={pair.from}>
            Depended on by {name(pair.from)}: {declarations(pair)}
          </li>
        ))}
      </ul>
    </section>
  );
}
