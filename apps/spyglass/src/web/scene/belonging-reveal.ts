import type { BelongingLayer } from "../layout/belonging";
import type { ViewState } from "./view-state";

/** How long a belonging layer takes to come up when it changes. */
const revealMs = 240;

/**
 * Applies a belonging layer to the view state and, when it is a different
 * island's, a different group's, or the first with regions, brings it up
 * over `revealMs`; reduced motion shows it at once. Applying a layer ends any
 * reveal still running and drops the pointer's hover over the old one.
 */
export function createBelongingReveal(context: {
  reducedMotion: Pick<MediaQueryList, "matches">;
  visible?: () => boolean;
  render: () => void;
  state: ViewState;
}) {
  const { reducedMotion, render, state } = context;
  let frame = 0;
  const animate = (start: number) => {
    const progress = Math.min(1, (performance.now() - start) / revealMs);
    state.belongingReveal = 1 - (1 - progress) ** 3;
    render();
    if (progress < 1) {
      frame = requestAnimationFrame(() => animate(start));
    }
  };
  return {
    dispose() {
      cancelAnimationFrame(frame);
    },
    finish() {
      cancelAnimationFrame(frame);
      state.belongingReveal = undefined;
    },
    set(value: BelongingLayer | null) {
      if (value?.featureFocus) {
        state.selectedFile = null;
      }
      cancelAnimationFrame(frame);
      const previous = state.belonging;
      const changed =
        previous?.territory.id !== value?.territory.id ||
        previous?.parents?.at(-1)?.id !== value?.parents?.at(-1)?.id ||
        (!previous?.regions.length && !!value?.regions.length);
      state.belonging = value;
      state.belongingHover = null;
      state.belongingReveal = undefined;
      if (
        value &&
        changed &&
        !reducedMotion.matches &&
        (context.visible?.() ?? true)
      ) {
        state.belongingReveal = 0;
        animate(performance.now());
      }
    },
  };
}
