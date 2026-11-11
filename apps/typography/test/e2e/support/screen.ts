/**
 * What the end-to-end files share about the screen: the sizes it is looked
 * at, how long it is given, and how one of its sections is found.
 */
import type { Page } from "playwright-core";

/** The desktop the app is designed at. */
export const WIDE = { height: 900, width: 1440 };
/** A phone's width, tall enough to photograph a whole place. */
export const NARROW = { height: 2600, width: 390 };
/** A phone as it is held. */
export const PHONE = { height: 844, width: 390 };
/** Long enough for a resize or a scroll to settle before it is looked at. */
export const SETTLE_MS = 250;
/** The engine starts in a second or two; a static build takes a few more. */
export const BUILD_TIMEOUT = 150_000;

/** A section by its accessible name: the region a ruled section makes. */
export const section = (page: Page, name: string) =>
  page.getByRole("region", { exact: true, name });

/** A section by the heading it prints, for the places whose sections name no region. */
export const headedSection = (page: Page, heading: string) =>
  page.locator("section.ty-section", {
    has: page.getByRole("heading", { exact: true, level: 2, name: heading }),
  });
