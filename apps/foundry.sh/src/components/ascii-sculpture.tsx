import type { ChangeEvent, ErrorInfo, MouseEvent, ReactNode } from "react";
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { asciiFallback } from "./ascii-fallback";
import type { SculptureShape } from "./ascii-scene";

const AsciiScene = lazy(() => import("./ascii-scene"));
const shapes: SculptureShape[] = ["Weave", "Stack", "Loop"];

// A renderer failure must leave the server-rendered artwork and page usable.
class SceneBoundary extends Component<
  { children: ReactNode; onFailure: () => void },
  { failed: boolean }
> {
  state: { failed: boolean } = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    this.props.onFailure();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function AsciiSculpture() {
  const container = useRef<HTMLElement>(null);
  const [activated, setActivated] = useState(false);
  const [visible, setVisible] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [shape, setShape] = useState<SculptureShape>("Weave");
  const [turn, setTurn] = useState(0);
  const onReady = useCallback(() => setReady(true), []);
  const onFailure = useCallback(() => {
    setUnavailable(true);
    setReady(false);
  }, []);

  const changeShape = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const next = shapes.find((item) => item === event.currentTarget.value);
    if (next) {
      setShape(next);
    }
  }, []);
  const toggleMotion = useCallback(() => setPlaying((current) => !current), []);
  const changeTurn = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTurn(Number(event.currentTarget.value));
    setPlaying(false);
  }, []);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncMotion = () => setPlaying(!preference.matches);
    syncMotion();
    preference.addEventListener("change", syncMotion);
    return () => preference.removeEventListener("change", syncMotion);
  }, []);

  useEffect(() => {
    const element = container.current;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: React assigns and clears the DOM ref outside this effect.
    if (!element) {
      return;
    }
    let intersecting = false;
    const syncVisibility = () => setVisible(intersecting && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry?.isIntersecting ?? false;
      if (intersecting) {
        setActivated(true);
      }
      syncVisibility();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, []);

  return (
    <figure className="sculpture" ref={container}>
      <div aria-hidden="true" className="sculpture-stage">
        <pre className="ascii-fallback" hidden={ready}>
          {asciiFallback}
        </pre>
        {activated && !unavailable && (
          <SceneBoundary onFailure={onFailure}>
            <Suspense fallback={null}>
              <AsciiScene
                active={visible && playing}
                onFailure={onFailure}
                onReady={onReady}
                shape={shape}
                turn={turn}
              />
            </Suspense>
          </SceneBoundary>
        )}
      </div>
      <figcaption className="sculpture-caption">
        <span>A little room to play.</span>
        <span>
          {unavailable ? "A study in characters." : "A study in possibility."}
        </span>
      </figcaption>
      <div
        className="sculpture-controls"
        style={{ visibility: ready ? "visible" : "hidden" }}
      >
        <fieldset aria-label="Sculpture form" className="shape-controls">
          {shapes.map((item) => (
            <button
              aria-pressed={shape === item}
              key={item}
              onClick={changeShape}
              type="button"
              value={item}
            >
              {item}
            </button>
          ))}
        </fieldset>
        <button
          aria-label={
            playing ? "Pause sculpture motion" : "Play sculpture motion"
          }
          className="motion-control"
          onClick={toggleMotion}
          type="button"
        >
          {playing ? "Pause" : "Play"}
          <svg
            aria-hidden="true"
            fill="currentColor"
            height="14"
            viewBox="0 0 16 16"
            width="14"
          >
            {playing ? (
              <path d="M4 3h3v10H4zm5 0h3v10H9z" />
            ) : (
              <path d="m4 2 9 6-9 6z" />
            )}
          </svg>
        </button>
        <label className="turn-control">
          Turn the form
          <input
            aria-label="Turn the form"
            max="360"
            min="0"
            onChange={changeTurn}
            type="range"
            value={turn}
          />
        </label>
      </div>
    </figure>
  );
}
