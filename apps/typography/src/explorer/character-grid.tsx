import "./coverage.css";
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FaceCoverage } from "~/library/face-coverage";
import { useFontStatus } from "~/library/font-status";
import { useProject } from "~/library/use-face";
import type { Face } from "~/typeface/face";
import { GlyphGrid } from "~/ui/content/glyph-grid";
import { ScrollRegion } from "~/ui/layout/scroll-region";
import type { CharacterStatus } from "~/unicode/coverage";
import { fontVariationSettings } from "~/workspace/browser-fonts";
import { useWorkspace } from "~/workspace/react";
import { useFontFamily } from "~/workspace/services";
import { CharacterCell } from "./character-cell";
import { drawsWorkingOutline } from "./character-status";
import { crossSectionTarget } from "./grid-keys";
import {
  columnsFor,
  type GridSection,
  layoutGrid,
  offsetOfCharacter,
  visibleWindows,
} from "./grid-layout";
import { characterShape } from "./inspection";

const CELL_WIDTH = 56;
const HEADING_HEIGHT = 44;
const SECTION_GAP = 24;
const OVERSCAN_ROWS = 4;
/** Scrolling re-renders once per this many pixels, not once per pixel. */
const SCROLL_STEP = 26;

/** Used until the grid has been measured, and where nothing can be measured. */
const UNMEASURED = { columns: 12, rowHeight: 52, viewport: 640 } as const;

/** True when the cell's row is the first or last one rendered, not of the section itself. */
const atWindowEdge = (
  cells: readonly HTMLElement[],
  cell: HTMLElement,
  key: string
) => {
  const block = cell.closest<HTMLElement>(".ty-coverage-block");
  if (key === "ArrowDown") {
    return (
      block?.dataset.reachesEnd === "false" &&
      cell.offsetTop === cells.at(-1)?.offsetTop
    );
  }
  return (
    key === "ArrowUp" &&
    block?.dataset.reachesStart === "false" &&
    cell.offsetTop === cells[0]?.offsetTop
  );
};

/**
 * Answers the arrow keys the glyph grid cannot: across a section boundary
 * focus moves into the next section, and at the edge of the rendered rows the
 * grid scrolls one row so the next press finds a cell to move to.
 */
const crossSections = (event: KeyboardEvent) => {
  const grid = event.currentTarget;
  const origin = event.target;
  if (
    event.defaultPrevented ||
    !(grid instanceof HTMLElement && origin instanceof HTMLElement)
  ) {
    return;
  }
  const sections = Array.from(
    grid.querySelectorAll<HTMLElement>(".ty-coverage-block"),
    (block) => Array.from(block.querySelectorAll<HTMLElement>("button"))
  );
  const section = sections.findIndex((placed) => placed.includes(origin));
  const cells = sections[section] ?? [];
  if (atWindowEdge(cells, origin, event.key)) {
    event.preventDefault();
    grid.parentElement?.scrollBy({
      top: (event.key === "ArrowDown" ? 1 : -1) * origin.offsetHeight,
    });
    return;
  }
  const target = crossSectionTarget(
    sections.map((placed) =>
      placed.map((button) => ({
        left: button.offsetLeft,
        top: button.offsetTop,
      }))
    ),
    { cell: cells.indexOf(origin), section },
    event.key
  );
  const cell = target && sections[target.section]?.[target.cell];
  if (cell) {
    event.preventDefault();
    cell.focus();
  }
};

interface Frame {
  readonly viewport: number;
  readonly width: number;
}

/** A request to bring a character's row into view. A new object asks again. */
export interface Reveal {
  readonly codePoint: number;
}

interface CharacterGridProps {
  readonly coverage: FaceCoverage;
  readonly face: Face;
  /** Names the scrolling region, for example "Devanagari characters". */
  readonly label: string;
  readonly onSelect: (codePoint: number) => void;
  readonly reveal: Reveal | undefined;
  readonly sections: readonly GridSection[];
  readonly selected: number | undefined;
}

/**
 * Characters in headed sections of glyph cells, inside a frame that scrolls.
 * Only the rows near the frame are in the page, so a script of any size
 * scrolls at the same speed.
 */
export function CharacterGrid({
  coverage,
  face,
  label,
  onSelect,
  reveal,
  sections,
  selected,
}: CharacterGridProps) {
  const workspace = useWorkspace();
  const project = useProject();
  const family = useFontFamily(face.id);
  const fontStatus = useFontStatus(family);
  const content = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<Frame>({ viewport: 0, width: 0 });
  const [rowHeight, setRowHeight] = useState<number>(UNMEASURED.rowHeight);
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    const element = content.current;
    const scroller = element?.parentElement;
    if (!scroller) {
      return;
    }
    const measure = () =>
      setFrame((previous) =>
        previous.width === element.clientWidth &&
        previous.viewport === scroller.clientHeight
          ? previous
          : { viewport: scroller.clientHeight, width: element.clientWidth }
      );
    const follow = () =>
      setScrollTop(Math.floor(scroller.scrollTop / SCROLL_STEP) * SCROLL_STEP);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(scroller);
    scroller.addEventListener("scroll", follow, { passive: true });
    // Runs after the glyph grid's own listener, which handles moves inside a section.
    element.addEventListener("keydown", crossSections);
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", follow);
      element.removeEventListener("keydown", crossSections);
    };
  }, []);

  // The design system sets the height of a cell, so it is read, not assumed.
  useEffect(() => {
    const height = content.current
      ?.querySelector("button")
      ?.getBoundingClientRect().height;
    if (height && Math.abs(height - rowHeight) > 0.01) {
      setRowHeight(height);
    }
  });

  const layout = useMemo(
    () =>
      layoutGrid(sections, {
        columns:
          frame.width > 0
            ? // The grid's cells overhang its frame by the one-pixel rule they share.
              columnsFor(frame.width + 1, CELL_WIDTH)
            : UNMEASURED.columns,
        gap: SECTION_GAP,
        headingHeight: HEADING_HEIGHT,
        rowHeight,
      }),
    [frame.width, rowHeight, sections]
  );

  // Other characters start at the top, unless one of them was asked for.
  const shownSections = useRef(sections);
  const answered = useRef<Reveal>(undefined);
  useEffect(() => {
    const scroller = content.current?.parentElement;
    if (!scroller) {
      return;
    }
    const offset =
      reveal && reveal !== answered.current
        ? offsetOfCharacter(layout, reveal.codePoint)
        : undefined;
    if (offset !== undefined) {
      answered.current = reveal;
      scroller.scrollTop = Math.max(0, offset - layout.metrics.rowHeight);
    } else if (shownSections.current !== sections) {
      scroller.scrollTop = 0;
    }
    shownSections.current = sections;
  }, [layout, reveal, sections]);

  const windows = useMemo(
    () =>
      visibleWindows(
        layout,
        scrollTop,
        (frame.viewport || UNMEASURED.viewport) + SCROLL_STEP,
        OVERSCAN_ROWS
      ),
    [frame.viewport, layout, scrollTop]
  );

  const setAsText = family !== undefined && fontStatus === "loaded";
  const drawsSource = fontStatus === "unavailable";
  const shapeOf = (codePoint: number, status: CharacterStatus) =>
    drawsWorkingOutline(status) || (status === "source" && drawsSource)
      ? characterShape(workspace, project, face.id, codePoint, status)
      : undefined;
  const faceStyle: CSSProperties | undefined = setAsText
    ? {
        fontFamily: `"${family}"`,
        fontVariationSettings: face.pinned
          ? fontVariationSettings(face.pinned.location)
          : "normal",
      }
    : undefined;

  return (
    <ScrollRegion label={label}>
      <div
        className="ty-coverage-grid"
        ref={content}
        style={{ height: layout.height }}
      >
        {windows.map(({ characters, endRow, firstRow, placed }) => (
          <div
            className="ty-coverage-block"
            data-reaches-end={endRow === placed.rows}
            data-reaches-start={firstRow === 0}
            key={placed.section.key}
            style={{ top: placed.top }}
          >
            <div
              className="ty-coverage-block-head"
              style={{ height: HEADING_HEIGHT }}
            >
              <h3 className="ty-label">{placed.section.title}</h3>
              <span>{placed.section.detail}</span>
            </div>
            <div
              data-set-as={setAsText ? "text" : "outlines"}
              style={{ ...faceStyle, paddingTop: firstRow * rowHeight }}
            >
              <GlyphGrid cellWidth={CELL_WIDTH} label={placed.section.title}>
                {Array.from(characters, (codePoint) => {
                  const status = coverage.classification.classify(codePoint);
                  return (
                    <CharacterCell
                      codePoint={codePoint}
                      face={face}
                      key={codePoint}
                      onSelect={onSelect}
                      selected={codePoint === selected}
                      setAsText={setAsText}
                      shape={shapeOf(codePoint, status)}
                      status={status}
                    />
                  );
                })}
              </GlyphGrid>
            </div>
          </div>
        ))}
      </div>
    </ScrollRegion>
  );
}
