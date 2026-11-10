import {
  type FormEvent,
  type KeyboardEvent,
  type UIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type GlyphRef, glyphRefKey, sameGlyph } from "~/typeface/changes";
import {
  type Face,
  type FaceMetrics,
  faceListLabel,
  isVariable,
} from "~/typeface/face";
import type { GlyphShape } from "~/typeface/reading";
import { codePointName } from "~/ui/content/code-point";
import { SearchField } from "~/ui/controls/search-field";
import { Select } from "~/ui/controls/select";
import { searchCharacters } from "~/unicode/search";
import type { GlyphEntry } from "~/workspace/glyphs";
import { GlyphDrawing } from "./glyph-drawing";
import { findGlyphs } from "./glyph-finding";
import { rowWindow, scrollToRow } from "./row-window";
import { studioHash } from "./studio-address";

const ROW_HEIGHT = 40;
const DRAWING_HEIGHT = 26;
const NAME_SEARCH_LIMIT = 60;
const NO_CHARACTERS: readonly number[] = [];

const faceLabel = (face: Face) =>
  isVariable(face) ? `${faceListLabel(face)}, variable` : faceListLabel(face);

const charactersLabel = (entry: GlyphEntry) =>
  entry.characters.length === 0
    ? "no character"
    : entry.characters.slice(0, 2).map(codePointName).join(", ");

const madeLabel = (entry: GlyphEntry) => {
  if (entry.ref.kind === "added") {
    return "Added";
  }
  return entry.edited ? "Edited" : undefined;
};

/** Scrolls the list so a row is in view, or to the top when no row is meant. */
const showRow = (element: HTMLDivElement | null, index: number) => {
  if (!element) {
    return;
  }
  const top =
    index === -1
      ? 0
      : scrollToRow(index, {
          rowHeight: ROW_HEIGHT,
          scrollTop: element.scrollTop,
          viewportHeight: element.clientHeight,
        });
  element.scrollTop = top;
  return { height: element.clientHeight, top };
};

interface GlyphRowProps {
  readonly current: boolean;
  readonly entry: GlyphEntry;
  readonly faceId: string;
  readonly metrics: FaceMetrics;
  readonly shape: GlyphShape | undefined;
}

function GlyphRow({ current, entry, faceId, metrics, shape }: GlyphRowProps) {
  const made = madeLabel(entry);
  return (
    <li>
      <a
        aria-current={current ? "true" : undefined}
        href={studioHash(faceId, entry.ref)}
      >
        <span className="ty-studio-glyph-picture">
          {shape ? (
            <GlyphDrawing
              advance={shape.advance}
              height={DRAWING_HEIGHT}
              metrics={metrics}
              outline={shape.outline}
              tone={made ? "carbon" : "ink"}
            />
          ) : null}
        </span>
        <span className="ty-studio-glyph-name">{entry.name}</span>
        <span className="ty-code">{charactersLabel(entry)}</span>
        {made ? <span className="ty-label ty-carbon">{made}</span> : null}
      </a>
    </li>
  );
}

interface GlyphChooserProps {
  readonly current: GlyphRef;
  /** Every glyph of the face, source and added. */
  readonly entries: readonly GlyphEntry[];
  readonly face: Face;
  readonly faces: readonly Face[];
  readonly onFace: (faceId: string) => void;
  /** Opens a glyph, for Enter in the search field. */
  readonly onGlyph: (ref: GlyphRef) => void;
  /** The glyph as the project has it, for the small pictures. */
  readonly shapeOf: (ref: GlyphRef) => GlyphShape | undefined;
}

/**
 * Choosing what to edit: a face, then a glyph by typing its character, a
 * name, a code point or a glyph id, or by picking from the list of every
 * glyph the face has. Only the rows on screen are rendered.
 */
export function GlyphChooser({
  current,
  entries,
  face,
  faces,
  onFace,
  onGlyph,
  shapeOf,
}: GlyphChooserProps) {
  const [query, setQuery] = useState("");
  const [named, setNamed] = useState(NO_CHARACTERS);
  const [scroll, setScroll] = useState({ height: 0, top: 0 });
  const list = useRef<HTMLDivElement>(null);

  // Words are matched against Unicode character names, which load on demand.
  useEffect(() => {
    const text = query.trim();
    if ([...text].length < 2) {
      setNamed(NO_CHARACTERS);
      return;
    }
    let stale = false;
    searchCharacters(text, { limit: NAME_SEARCH_LIMIT }).then((characters) => {
      if (!stale) {
        setNamed(characters);
      }
    });
    return () => {
      stale = true;
    };
  }, [query]);

  const found = useMemo(
    () => findGlyphs(entries, query, named),
    [entries, named, query]
  );
  const rows = rowWindow({
    count: found.length,
    rowHeight: ROW_HEIGHT,
    scrollTop: scroll.top,
    viewportHeight: scroll.height,
  });

  const follow = useCallback((event: UIEvent<HTMLDivElement>) => {
    const { clientHeight, scrollTop } = event.currentTarget;
    setScroll({ height: clientHeight, top: scrollTop });
  }, []);

  // Brings the open glyph into view when it changes, as after a link from elsewhere.
  const currentIndex = useMemo(
    () => found.findIndex((entry) => sameGlyph(entry.ref, current)),
    [current, found]
  );
  useEffect(() => {
    const shown = showRow(list.current, currentIndex);
    if (shown) {
      setScroll(shown);
    }
  }, [currentIndex]);

  const openFirst = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const [first] = found;
      if (first) {
        onGlyph(first.ref);
        // With the glyph open, the whole list comes back, scrolled to it.
        setQuery("");
      }
    },
    [found, onGlyph]
  );

  const moveFocus = useCallback((event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const row = (event.target as HTMLElement).closest("li");
    const next =
      event.key === "ArrowDown"
        ? row?.nextElementSibling
        : row?.previousElementSibling;
    const link = next?.querySelector("a");
    if (link) {
      event.preventDefault();
      link.focus();
    }
  }, []);

  const options = useMemo(
    () => faces.map((known) => ({ label: faceLabel(known), value: known.id })),
    [faces]
  );
  const { metrics } = face.description;

  return (
    <div className="ty-studio-chooser">
      <Select
        label="Face"
        onChange={onFace}
        options={options}
        value={face.id}
      />
      <form onSubmit={openFirst}>
        <SearchField
          label="Find a glyph"
          onChange={setQuery}
          placeholder="a, U+0061, #45 or a name"
          value={query}
        />
      </form>
      <p aria-live="polite" className="ty-label">
        {query.trim() === ""
          ? `${entries.length} glyphs`
          : `${found.length} of ${entries.length} glyphs`}
      </p>
      <div
        className="ty-scroll ty-studio-glyph-list"
        data-axis="y"
        onScroll={follow}
        ref={list}
      >
        {found.length === 0 ? (
          <p>
            No glyph matches. Try a single character, a code point such as
            U+0061, or part of a glyph name.
          </p>
        ) : (
          <nav aria-label="Glyphs" style={{ height: rows.totalHeight }}>
            {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: the list only moves focus between its own links. */}
            <ul onKeyDown={moveFocus} style={{ paddingTop: rows.offset }}>
              {found.slice(rows.first, rows.last).map((entry) => (
                <GlyphRow
                  current={sameGlyph(entry.ref, current)}
                  entry={entry}
                  faceId={face.id}
                  key={glyphRefKey(entry.ref)}
                  metrics={metrics}
                  shape={shapeOf(entry.ref)}
                />
              ))}
            </ul>
          </nav>
        )}
      </div>
    </div>
  );
}
