import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "~/app/lib/cn";

import "./page-vignette.css";

interface PageVignetteProps {
  /** Opacity of the vignette colour at the outer edge, as a percentage. */
  edgeStrength?: number;
  /** Vertical position of the focal point, 0 to 100. */
  focalY?: number;
  /** Ellipse x-radius as a percentage of the container width. */
  radiusX?: number;
  /** Ellipse y-radius as a percentage of the container height. */
  radiusY?: number;
  /** Where the clear center ends, 0 to 100. Lower is tighter and more dramatic. */
  spread?: number;
}

const DEFAULT_SPREAD = 30;
const DEFAULT_FOCAL_Y = 38;
const DEFAULT_RADIUS_X = 82;
const DEFAULT_RADIUS_Y = 78;
const DEFAULT_EDGE_STRENGTH = 100;
const DEFAULT_FADE_SIZE = 32;

/** Ambient vignette overlay: transparent center, fading to background at the edges. */
function PageVignette({
  spread = DEFAULT_SPREAD,
  focalY = DEFAULT_FOCAL_Y,
  radiusX = DEFAULT_RADIUS_X,
  radiusY = DEFAULT_RADIUS_Y,
  edgeStrength = DEFAULT_EDGE_STRENGTH,
}: PageVignetteProps) {
  return (
    <div
      aria-hidden="true"
      className="page-vignette"
      style={
        {
          "--page-vignette-edge-strength": `${edgeStrength}%`,
          "--page-vignette-focal-y": `${focalY}%`,
          "--page-vignette-rx": `${radiusX}%`,
          "--page-vignette-ry": `${radiusY}%`,
          "--page-vignette-spread": `${spread}%`,
        } as CSSProperties
      }
    />
  );
}

interface ScrollEdges {
  canScrollDown: boolean;
  canScrollUp: boolean;
}

const INITIAL_EDGES: ScrollEdges = { canScrollDown: false, canScrollUp: false };

interface VignetteScrollAreaProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  children: ReactNode;
  fadeSize?: number | string;
  surfaceColor?: string;
  viewportClassName?: string;
}

/** Scroll frame with short, state-aware fades at its vertical edges. */
function VignetteScrollArea({
  children,
  className,
  viewportClassName,
  fadeSize = DEFAULT_FADE_SIZE,
  surfaceColor = "var(--background)",
  style,
  ...props
}: VignetteScrollAreaProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<ScrollEdges>(INITIAL_EDGES);

  const measureEdges = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport === null) {
      return;
    }
    const maxScrollTop = Math.max(
      0,
      viewport.scrollHeight - viewport.clientHeight
    );
    const next: ScrollEdges = {
      canScrollDown: viewport.scrollTop < maxScrollTop - 1,
      canScrollUp: viewport.scrollTop > 1,
    };
    setEdges((current) =>
      current.canScrollUp === next.canScrollUp &&
      current.canScrollDown === next.canScrollDown
        ? current
        : next
    );
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) {
      return;
    }

    measureEdges();
    viewport.addEventListener("scroll", measureEdges, { passive: true });

    const observeChildren = (observer: ResizeObserver) => {
      observer.observe(viewport);
      for (const child of viewport.children) {
        observer.observe(child);
      }
    };
    const resizeObserver = new ResizeObserver(measureEdges);
    observeChildren(resizeObserver);

    const mutationObserver = new MutationObserver(() => {
      resizeObserver.disconnect();
      observeChildren(resizeObserver);
      measureEdges();
    });
    mutationObserver.observe(viewport, { childList: true });

    return () => {
      viewport.removeEventListener("scroll", measureEdges);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [measureEdges]);

  const resolvedFadeSize =
    typeof fadeSize === "number" ? `${fadeSize}px` : fadeSize;

  return (
    <div
      className={cn("vignette-scroll-frame", className)}
      data-slot="vignette-scroll-frame"
      style={
        {
          ...style,
          "--vignette-scroll-fade-size": resolvedFadeSize,
          "--vignette-scroll-surface": surfaceColor,
        } as CSSProperties
      }
      {...props}
    >
      <div
        className={cn("vignette-scroll-viewport", viewportClassName)}
        data-slot="vignette-scroll-viewport"
        ref={viewportRef}
      >
        {children}
      </div>

      <div
        aria-hidden="true"
        className="vignette-scroll-fade vignette-scroll-fade--top"
        data-slot="vignette-scroll-fade-top"
        data-visible={edges.canScrollUp}
      />
      <div
        aria-hidden="true"
        className="vignette-scroll-fade vignette-scroll-fade--bottom"
        data-slot="vignette-scroll-fade-bottom"
        data-visible={edges.canScrollDown}
      />
    </div>
  );
}

export interface VignettePageProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  children: ReactNode;
  fadeSize?: number | string;
  scrollAreaClassName?: string;
  surfaceColor?: string;
  /** Decorative content rendered behind the vignette and scroll viewport. */
  underlay?: ReactNode;
  /** Classes applied to the single route-level scrolling viewport. */
  viewportClassName?: string;
  vignette?: PageVignetteProps;
}

/**
 * A full-height page shell with one route-level vertical scroll owner. Put
 * headers, toolbars, and content inside so they share the same flow.
 */
export function VignettePage({
  children,
  className,
  underlay,
  vignette,
  viewportClassName,
  scrollAreaClassName,
  fadeSize,
  surfaceColor,
  ...props
}: VignettePageProps) {
  return (
    <div
      className={cn("vignette-shell", className)}
      data-slot="vignette-page"
      {...props}
    >
      {underlay}
      <PageVignette {...vignette} />
      <VignetteScrollArea
        className={cn("h-full", scrollAreaClassName)}
        fadeSize={fadeSize}
        surfaceColor={surfaceColor}
        viewportClassName={viewportClassName}
      >
        {children}
      </VignetteScrollArea>
    </div>
  );
}
