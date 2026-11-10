import { type ComponentType, type LazyExoticComponent, lazy } from "react";
import type { PlaceSymbolName } from "~/ui/symbols/line-symbol";
import { hashFor } from "./hash-location";

/** What the shell hands a screen: the path below its place. */
interface ScreenProps {
  /** For "#/studio/<face>/<glyph>" the studio gets ["<face>", "<glyph>"]. */
  readonly path: readonly string[];
}

type Screen = LazyExoticComponent<ComponentType<ScreenProps>>;

interface Destination {
  /** The first segment of the address: "#/library". */
  readonly id: string;
  readonly name: string;
  /** Left out until the screen exists. The shell then says so. */
  readonly screen?: Screen;
  readonly symbol?: PlaceSymbolName;
}

export interface Place extends Destination {
  readonly symbol: PlaceSymbolName;
}

const START: Place = {
  id: "import",
  name: "Import",
  screen: lazy(() => import("~/import/import-screen")),
  symbol: "import",
};

/**
 * The places of the app, in the order of the strip. A screen is plugged in
 * here and nowhere else, as a lazily loaded default export:
 * `screen: lazy(() => import("~/library/library-screen"))`.
 */
export const PLACES: readonly Place[] = [
  START,
  {
    id: "library",
    name: "Library",
    screen: lazy(() => import("~/library/library-screen")),
    symbol: "library",
  },
  {
    id: "coverage",
    name: "Coverage",
    screen: lazy(() => import("~/explorer/coverage-screen")),
    symbol: "coverage",
  },
  {
    id: "studio",
    name: "Studio",
    screen: lazy(() => import("~/studio/studio-screen")),
    symbol: "studio",
  },
  {
    id: "generate",
    name: "Generate",
    screen: lazy(() => import("~/generate/generate-screen")),
    symbol: "generate",
  },
  {
    id: "reconstruct",
    name: "Reconstruct",
    screen: lazy(() => import("~/reconstruct/reconstruct-screen")),
    symbol: "reconstruct",
  },
  {
    id: "proof",
    name: "Proof",
    screen: lazy(() => import("~/proof/proof-screen")),
    symbol: "proof",
  },
  {
    id: "export",
    name: "Export",
    screen: lazy(() => import("~/export/export-screen")),
    symbol: "export",
  },
];

/** The design system specimen. Reachable by address, absent from the strip. */
const SYSTEM: Destination = {
  id: "system",
  name: "Design system",
  screen: lazy(() => import("./system/system-screen")),
};

export type Route =
  | {
      readonly destination: Destination;
      readonly kind: "destination";
      readonly path: readonly string[];
    }
  | { readonly address: string; readonly kind: "unknown" };

/** An empty path opens the first place. */
export const resolveRoute = (path: readonly string[]): Route => {
  const [id, ...rest] = path;
  if (id === undefined) {
    return { destination: START, kind: "destination", path: [] };
  }
  const destination = [...PLACES, SYSTEM].find((place) => place.id === id);
  return destination
    ? { destination, kind: "destination", path: rest }
    : { address: hashFor(...path), kind: "unknown" };
};
