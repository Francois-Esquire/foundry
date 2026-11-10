import type { ReactNode } from "react";

/*
 * Every drawing is one-pixel line on half-pixel coordinates, so strokes land
 * on whole pixels at the drawn size. Places sit on a 40 unit grid, marks and
 * control symbols on a 22 unit grid. The stylesheet supplies stroke, fill
 * and non-scaling stroke.
 */

const DOTTED = "1.5 2";

export const PLACE_DRAWINGS = {
  coverage: (
    <path d="M7.5 7.5H33.5V33.5H7.5ZM20.5 7.5V33.5M7.5 20.5H33.5M24 24 30 30M30 24 24 30" />
  ),
  export: (
    <>
      <path d="M7.5 9.5H25L34 20.5 25 31.5H7.5Z" />
      <circle cx="26" cy="20.5" r="1.75" />
    </>
  ),
  generate: (
    <>
      <path d="M20.5 7.5A13 13 0 0 0 20.5 33.5" />
      <path d="M20.5 7.5A13 13 0 0 1 20.5 33.5" strokeDasharray="1.5 2.6" />
    </>
  ),
  import: (
    <path d="M7.5 13.5 11.5 33.5H29.5L33.5 13.5M20.5 4V24.5M15 19 20.5 24.5 26 19" />
  ),
  library: (
    <path d="M7.5 7.5H33.5V33.5H7.5ZM13 15.5H28M13 20.5H28M13 25.5H28" />
  ),
  proof: (
    <>
      <circle cx="20.5" cy="20.5" r="8" />
      <path d="M20.5 5V36M5 20.5H36" />
    </>
  ),
  reconstruct: (
    <path d="M7.5 14V7.5H14M27 7.5H33.5V14M33.5 27V33.5H27M14 33.5H7.5V27M14.5 28.5 20.5 12.5 26.5 28.5M16.8 22.5H24.2" />
  ),
  studio: (
    <>
      <path d="M6.5 33.5C6.5 20 12 12.5 20.5 12.5 29 12.5 34.5 20 34.5 33.5M9 12.5H18.5M22.5 12.5H32M18.5 10.5H22.5V14.5H18.5Z" />
      <circle cx="7.5" cy="12.5" r="1.5" />
      <circle cx="33.5" cy="12.5" r="1.5" />
    </>
  ),
} satisfies Record<string, ReactNode>;

const BOX = "M4.5 4.5H17.5V17.5H4.5Z";

export const MARK_DRAWINGS = {
  edited: <path d={BOX} />,
  missing: <path d={`${BOX}M4.5 4.5 17.5 17.5M17.5 4.5 4.5 17.5`} />,
  revisions: <path d="M4.5 2.5H17.5V15.5H4.5ZM4.5 19.5H17.5" />,
  source: <path d={BOX} />,
  unconfirmed: <path d={BOX} strokeDasharray={DOTTED} />,
} satisfies Record<string, ReactNode>;

export const CONTROL_DRAWINGS = {
  add: <path d="M10.5 4.5V16.5M4.5 10.5H16.5" />,
  check: <path d="M4.5 11.5 8.5 15.5 17.5 6.5" />,
  "chevron-down": <path d="M5.5 8.5 10.5 13.5 15.5 8.5" />,
  "chevron-left": <path d="M13.5 5.5 8.5 10.5 13.5 15.5" />,
  "chevron-right": <path d="M8.5 5.5 13.5 10.5 8.5 15.5" />,
  "chevron-up": <path d="M5.5 13.5 10.5 8.5 15.5 13.5" />,
  close: <path d="M5.5 5.5 16.5 16.5M16.5 5.5 5.5 16.5" />,
  compare: (
    <>
      <path d="M10.5 2.5V19.5M8.5 5.5H3.5V16.5H8.5" />
      <path d="M12.5 5.5H17.5V16.5H12.5" strokeDasharray={DOTTED} />
    </>
  ),
  download: (
    <path d="M10.5 3.5V13.5M6.5 9.5 10.5 13.5 14.5 9.5M4.5 14.5V17.5H16.5V14.5" />
  ),
  pin: <path d="M2.5 16.5H19.5M10.5 16.5V8.5M8.5 4.5H12.5V8.5H8.5Z" />,
  redo: (
    <path d="M16.5 8.5H8.5A4 4 0 0 0 8.5 16.5H13.5M13.5 5.5 16.5 8.5 13.5 11.5" />
  ),
  remove: <path d="M4.5 10.5H16.5" />,
  search: (
    <>
      <circle cx="9.5" cy="9.5" r="5" />
      <path d="M13.5 13.5 17.5 17.5" />
    </>
  ),
  undo: (
    <path d="M5.5 8.5H13.5A4 4 0 0 1 13.5 16.5H8.5M8.5 5.5 5.5 8.5 8.5 11.5" />
  ),
} satisfies Record<string, ReactNode>;
