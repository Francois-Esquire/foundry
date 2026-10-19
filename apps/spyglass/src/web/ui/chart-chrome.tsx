import "./chart-frame.css";
import type { ChartChromeModel, ChromeText } from "./chart-chrome-model";
import { ChartCoordinates } from "./chart-coordinates";
import { latitudeScaleStyle } from "./chart-margin-layout";

function MarginText({
  item,
  className,
}: {
  item: ChromeText;
  className: string;
}) {
  return (
    <span className={`spyglass-note ${className}`} style={item.style}>
      {item.text}
    </span>
  );
}

/** Viewport furniture is rendered from prepared props, outside the GPU and map-label hosts. */
export function ChartChrome({ model }: { model: ChartChromeModel | null }) {
  if (!model) {
    return null;
  }
  const { scale } = model;
  const { tick, axis } = latitudeScaleStyle;
  return (
    <div
      aria-hidden="true"
      className="spyglass-labels spyglass-chart-chrome"
      style={model.plateStyle}
    >
      <div className="spyglass-margin">
        <ChartCoordinates
          coordinates={model.coordinates}
          geometry={model.geometry}
          height={model.height}
          width={model.width}
        />
        {scale && (
          <div className="spyglass-latitude" style={{ opacity: scale.opacity }}>
            <svg aria-hidden="true" className="spyglass-latitude-axis">
              <line
                stroke={axis.hue}
                strokeWidth={axis.weight}
                x1={scale.x}
                x2={scale.x}
                y1={scale.top}
                y2={scale.bottom}
              />
              {scale.ticks.map((each) => (
                <line
                  key={each.key}
                  stroke={axis.hue}
                  strokeWidth={axis.weight}
                  x1={scale.x - tick}
                  x2={scale.x + tick}
                  y1={each.y}
                  y2={each.y}
                />
              ))}
            </svg>
            {scale.ticks.map((each) => (
              <MarginText
                className={
                  scale.plated
                    ? "spyglass-latitude-label spyglass-plated"
                    : "spyglass-latitude-label"
                }
                item={each.label}
                key={each.key}
              />
            ))}
          </div>
        )}
        {model.notes.map((note) => (
          <MarginText
            className={`spyglass-${note.key}`}
            item={note}
            key={note.key}
          />
        ))}
      </div>
    </div>
  );
}
