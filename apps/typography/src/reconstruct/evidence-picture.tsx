import type { ComponentProps, CSSProperties, ReactNode } from "react";
import type { Box } from "./region-geometry";
import type { Photograph } from "./use-session";

interface EvidencePictureProps
  extends Omit<
    ComponentProps<"svg">,
    "aria-label" | "role" | "style" | "viewBox"
  > {
  /** Drawn over the photograph, in evidence pixels with y down. */
  readonly children?: ReactNode;
  /** The part of the photograph to show. The whole of it when absent. */
  readonly crop?: Box;
  /** What the picture shows, for someone who cannot see it. */
  readonly label: string;
  readonly photograph: Photograph;
}

/**
 * The evidence photograph, drawn from its own file, with whatever was found
 * in it laid over. The overlay is separate drawing: the photograph is shown
 * and never changed.
 */
export function EvidencePicture({
  children,
  className,
  crop,
  label,
  photograph,
  ...rest
}: EvidencePictureProps) {
  const { evidence, url } = photograph;
  const box = crop ?? {
    height: evidence.height,
    width: evidence.width,
    x: 0,
    y: 0,
  };
  return (
    <svg
      aria-label={label}
      className={["ty-reconstruct-picture", className]
        .filter(Boolean)
        .join(" ")}
      role="img"
      style={{ "--ty-aspect": box.width / box.height } as CSSProperties}
      viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
      {...rest}
    >
      <image height={evidence.height} href={url} width={evidence.width} />
      {children}
    </svg>
  );
}

interface OverlayShapeProps {
  /** SVG path data in evidence pixels. */
  readonly d: string;
}

/** An interface line over a photograph: ink, on a wider band of tape so it shows on any ground. */
export function OverlayLine({ d }: OverlayShapeProps) {
  return (
    <>
      <path className="ty-reconstruct-halo" d={d} />
      <path className="ty-reconstruct-line" d={d} />
    </>
  );
}

/** The path through points, closed. */
export const polygonPath = (
  points: readonly { readonly x: number; readonly y: number }[]
) =>
  points.length === 0
    ? ""
    : `M${points.map((point) => `${point.x} ${point.y}`).join("L")}Z`;
