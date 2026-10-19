import type { SceneLayer } from "./handle";

/**
 * Camera changes and detail reveals share one map repaint per display
 * frame. After each draw, `continues` is asked whether the next frame should
 * follow unasked: the loop that runs while a layer animates, and stops the
 * moment none does.
 */
export function createFrameRenderer(
  draw: () => void,
  continues: () => boolean = () => false
) {
  let frame = 0;
  let disposed = false;
  const request = () => {
    if (!(frame || disposed)) {
      frame = requestAnimationFrame(render);
    }
  };
  function render() {
    cancelAnimationFrame(frame);
    frame = 0;
    if (disposed) {
      return;
    }
    draw();
    if (continues()) {
      request();
    }
  }
  return {
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
    },
    request,
  };
}

/**
 * Whether the scene is in motion: some layer says it is animating, and the
 * reader has not asked for reduced motion, which stills every animated
 * layer without removing it.
 */
export function sceneAnimating(
  layers: readonly SceneLayer[],
  reducedMotion: { matches: boolean },
  enabled: (layer: SceneLayer) => boolean = () => true
): boolean {
  return (
    !reducedMotion.matches &&
    layers.some((layer) => enabled(layer) && layer.animating?.() === true)
  );
}
