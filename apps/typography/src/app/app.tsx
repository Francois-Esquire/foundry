import "./app.css";
import {
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { EmptyState } from "~/ui/content/empty-state";
import { ButtonLink } from "~/ui/controls/button";
import { ProgressLine } from "~/ui/controls/progress-line";
import { hashFor, useHashPath } from "./hash-location";
import { Masthead } from "./masthead";
import { PlaceStrip } from "./place-strip";
import { type Route, resolveRoute } from "./places";
import { ScreenBoundary } from "./screen-boundary";

function RouteContent({ route }: { readonly route: Route }) {
  if (route.kind === "unknown") {
    return (
      <EmptyState
        action={<ButtonLink href={hashFor()}>Go to Import</ButtonLink>}
        title="No such place"
      >
        Nothing lives at {route.address}. Check the address, or pick a place
        from the strip above.
      </EmptyState>
    );
  }
  const { name, screen: Screen, symbol } = route.destination;
  return Screen ? (
    <Screen path={route.path} />
  ) : (
    <EmptyState symbol={symbol} title={name}>
      This place is not built yet.
    </EmptyState>
  );
}

interface AppProps {
  /** Notices for the person, shown between the strip and the screen. */
  readonly notices?: ReactNode;
  /** Project status for the right of the masthead. */
  readonly status?: ReactNode;
}

/**
 * The shell: masthead, the strip of places, and the screen of the place the
 * address names. It fills the viewport and only the screen area scrolls.
 */
export function App({ notices, status }: AppProps) {
  const path = useHashPath();
  const route = useMemo(() => resolveRoute(path), [path]);
  const main = useRef<HTMLElement>(null);
  const known = route.kind === "destination";
  const id = known ? route.destination.id : undefined;
  const name = known ? route.destination.name : "No such place";

  useEffect(() => {
    document.title = `${name} - Typography`;
  }, [name]);

  // Arriving at another place starts at its top, with focus on its content.
  const shownId = useRef(id);
  useEffect(() => {
    if (shownId.current !== id) {
      shownId.current = id;
      main.current?.scrollTo({ top: 0 });
      main.current?.focus();
    }
  }, [id]);

  const skipToContent = useCallback(() => main.current?.focus(), []);

  return (
    <div className="ty-app">
      <button
        className="ty-label ty-app-skip"
        onClick={skipToContent}
        type="button"
      >
        Skip to content
      </button>
      <Masthead status={status} />
      <PlaceStrip currentId={id} />
      <div className="ty-app-notices-row">{notices}</div>
      <main className="ty-app-main" ref={main} tabIndex={-1}>
        <h1 className="ty-visually-hidden">{name}</h1>
        <ScreenBoundary key={id} name={name}>
          <Suspense fallback={<ProgressLine label={`Opening ${name}`} />}>
            <RouteContent route={route} />
          </Suspense>
        </ScreenBoundary>
      </main>
    </div>
  );
}
