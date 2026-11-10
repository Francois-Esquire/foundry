import { LineSymbol } from "~/ui/symbols/line-symbol";
import { hashFor } from "./hash-location";
import { PLACES } from "./places";

interface PlaceStripProps {
  /** The id of the place on screen, if the address names one. */
  readonly currentId?: string;
}

/** The eight places, each a symbol over its name. The current one is on. */
export function PlaceStrip({ currentId }: PlaceStripProps) {
  return (
    <nav aria-label="Places" className="ty-strip">
      <ul>
        {PLACES.map((place) => (
          <li key={place.id}>
            <a
              aria-current={place.id === currentId ? "page" : undefined}
              href={hashFor(place.id)}
            >
              <LineSymbol name={place.symbol} />
              <span className="ty-label">{place.name}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
