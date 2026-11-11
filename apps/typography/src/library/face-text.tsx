import "./face.css";
import { useMemo } from "react";
import { EMPTY_WORKING_FACE } from "~/typeface/changes";
import type { AxisLocation, Face } from "~/typeface/face";
import type { FeatureChoices } from "~/typeface/layout-features";
import type { TextDirection } from "~/typeface/reading";
import { setText } from "~/typeface/typesetting";
import { SetText } from "~/ui/content/set-text";
import { splitRuns } from "~/unicode/text-runs";
import { fontVariationSettings } from "~/workspace/browser-fonts";
import { useWorkspace } from "~/workspace/react";
import { useFontFamily } from "~/workspace/services";
import { useFontStatus } from "./font-status";
import { fontFeatureSettings } from "./layout-features";
import { LineDrawing } from "./outline-drawing";

const LINE_BREAK = /\r?\n/;

export interface FaceTextProps {
  /** Left out, the text decides: right to left when it holds such letters. */
  readonly direction?: TextDirection;
  readonly face: Face;
  readonly features: FeatureChoices;
  /** In pixels. */
  readonly fontSize: number;
  /** Whether the face holds a character. Anything else gets the crossed box. */
  readonly has: (codePoint: number) => boolean;
  /** BCP 47, so shaping picks the language's own forms. */
  readonly language?: string;
  /** Where a variable face sits. A pinned instance supplies its own. */
  readonly location?: AxisLocation;
  readonly text: string;
}

function FontText({
  direction,
  family,
  features,
  fontSize,
  has,
  language,
  location,
  text,
}: Omit<FaceTextProps, "face"> & { readonly family: string }) {
  const runs = useMemo(() => splitRuns(text, has), [text, has]);
  return (
    <SetText
      className="ty-face-text"
      direction={direction}
      family={family}
      features={fontFeatureSettings(features)}
      language={language}
      runs={runs}
      size={fontSize}
      variation={location ? fontVariationSettings(location) : "normal"}
    />
  );
}

function OutlineText({
  direction,
  face,
  features,
  fontSize,
  language,
  location,
  text,
}: FaceTextProps) {
  const workspace = useWorkspace();
  const lines = useMemo(() => {
    const open = workspace.openFace(face.id);
    let start = 0;
    return text.split(LINE_BREAK).map((line) => {
      const set = {
        key: start,
        line: setText(line, open, EMPTY_WORKING_FACE, {
          direction,
          features,
          language,
          location,
        }),
      };
      start += line.length + 1;
      return set;
    });
  }, [direction, face.id, features, language, location, text, workspace]);
  return (
    <span className="ty-face-text" data-setting="outlines" style={{ fontSize }}>
      <span className="ty-visually-hidden">{text}</span>
      {lines.map(({ key, line }) => (
        <LineDrawing key={key} line={line} metrics={face.description.metrics} />
      ))}
    </span>
  );
}

/**
 * Text set in a face's own source font. While the browser has the font, the
 * text is real text in it and every character the face lacks is the crossed
 * box. When the browser has no font for the face, the same text is drawn from
 * the face's outlines instead. A system fallback font is never used.
 */
export function FaceText(props: FaceTextProps) {
  const { face, fontSize } = props;
  const location = face.pinned?.location ?? props.location;
  const family = useFontFamily(face.id);
  const status = useFontStatus(family);
  if (family !== undefined && status === "loaded") {
    return <FontText {...props} family={family} location={location} />;
  }
  if (status === "loading") {
    return (
      <span
        className="ty-face-text"
        data-setting="loading"
        style={{ fontSize }}
      >
        <span className="ty-visually-hidden">Loading the font</span>
      </span>
    );
  }
  return <OutlineText {...props} location={location} />;
}
