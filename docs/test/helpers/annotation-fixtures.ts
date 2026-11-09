import type { AnnotationDocument } from "../../lib/annotations/model.ts";

export function drawingDocument(): AnnotationDocument {
  return {
    marks: [
      {
        anchor: { id: "the-model", x: 0.3, y: -0.2 },
        color: "#334455",
        id: "stroke-1",
        kind: "draw",
        points: [
          { x: 0, y: 0 },
          { x: 12, y: -8 },
        ],
        text: "",
      },
    ],
    version: 1,
  };
}
