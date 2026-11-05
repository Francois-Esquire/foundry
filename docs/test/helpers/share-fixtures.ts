import type { AnnotationDocument, Mark } from "../../annotations/model.ts";

function semantic(kind: Mark["kind"], index = 0): Mark {
  const quote = `Each run keeps its own result ${index + 1}.`;
  return {
    anchor: { id: `the-model:p:abc${index}:0`, x: 0.3, y: 0.2 },
    color: "#c93848",
    id: `12345678-1234-4234-8234-${String(index).padStart(12, "0")}`,
    kind,
    points:
      kind === "arrow"
        ? [
            { x: 0, y: 0 },
            { x: -90, y: -45 },
          ]
        : [],
    target: {
      segments: [
        {
          blockId: `the-model:p:abc${index}:0`,
          end: 20 + quote.length,
          prefix: "One definition, many runs. ",
          quote,
          start: 20,
          suffix: " Results remain inspectable.",
        },
      ],
    },
    text:
      kind === "comment"
        ? "This distinction matters: the definition is reusable; every run keeps separate state. 日本語 🖊️"
        : "",
  };
}

function noise(length: number, initial: number): string {
  let seed = initial;
  let text = "";
  for (let index = 0; index < length; index += 1) {
    seed = (seed * 48_271) % 2_147_483_647;
    text += String.fromCharCode(33 + (seed % 90));
  }
  return text;
}

function document(marks: Mark[]): AnnotationDocument {
  return { marks, version: 1 };
}

export function shareFixtures(): Record<string, AnnotationDocument> {
  return {
    arrow: document([semantic("arrow")]),
    comment: document([semantic("comment")]),
    "dense-stroke": document([
      {
        ...semantic("draw"),
        points: Array.from({ length: 2000 }, (_, index) => ({
          x: index / 4,
          y: Math.round(Math.sin(index / 40) * 1000) / 10,
        })),
        target: undefined,
      },
    ]),
    empty: document([]),
    highlight: document([semantic("highlight")]),
    "over-limit": document(
      Array.from({ length: 30 }, (_, index) => ({
        ...semantic("text", index),
        target: undefined,
        text: noise(2000, 17 + index),
      }))
    ),
    "ten-highlights": document(
      Array.from({ length: 10 }, (_, index) => semantic("highlight", index))
    ),
  };
}
