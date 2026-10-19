import { useId } from "react";
import type { ChartChromeModel } from "./chart-chrome-model";
import { gridReferenceStyle } from "./chart-margin-layout";
import { fontFamily } from "./map-labels/measure";

const lettering = {
  fontFamily: fontFamily(gridReferenceStyle.font),
  fontSize: gridReferenceStyle.size,
  letterSpacing: `${gridReferenceStyle.font.letterSpacing}em`,
};

/** The cast frame is UI-owned SVG. Both masks and outlines read the same coordinate props. */
export function ChartCoordinates({
  width,
  height,
  geometry,
  coordinates,
}: Pick<ChartChromeModel, "width" | "height" | "geometry" | "coordinates">) {
  const id = useId();
  const mask = `coordinate-cutout-${id}`;
  const clip = `coordinate-cast-${id}`;
  return (
    <svg
      aria-hidden="true"
      className="spyglass-chart-frame"
      viewBox={`0 0 ${width} ${height}`}
    >
      <defs>
        <mask
          height={height}
          id={mask}
          maskUnits="userSpaceOnUse"
          style={{ maskType: "luminance" }}
          width={width}
          x={0}
          y={0}
        >
          <rect fill="white" height="100%" width="100%" />
          {coordinates.map((reference) => (
            <text
              className="spyglass-reference"
              fill="black"
              key={reference.key}
              style={lettering}
              textAnchor="middle"
              x={reference.x}
              y={reference.y}
            >
              {reference.text}
            </text>
          ))}
        </mask>
        <clipPath id={clip}>
          <path d={geometry.panels} />
        </clipPath>
      </defs>
      <path className="spyglass-frame-rule" d={geometry.border} />
      <g mask={`url(#${mask})`}>
        <path className="spyglass-frame-panels" d={geometry.panels} />
        <path
          className="spyglass-cast-inset"
          clipPath={`url(#${clip})`}
          d={geometry.panels}
        />
        <path className="spyglass-cast-edge" d={geometry.panels} />
      </g>
      <path className="spyglass-corner-diamond" d={geometry.corner} />
      <path className="spyglass-frame-ornament" d={geometry.ornament} />
      <g>
        {coordinates.map((reference) => (
          <text
            className="spyglass-reference-outline"
            fill="none"
            key={reference.key}
            style={lettering}
            textAnchor="middle"
            x={reference.x}
            y={reference.y}
          >
            {reference.text}
          </text>
        ))}
      </g>
    </svg>
  );
}
