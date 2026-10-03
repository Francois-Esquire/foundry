/** Camera changes and detail reveals share one map repaint per display frame. */
export function createFrameRenderer(draw: () => void) {
  let frame = 0;
  let disposed = false;
  const render = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    if (!disposed) {
      draw();
    }
  };
  return {
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
    },
    request() {
      if (!(frame || disposed)) {
        frame = requestAnimationFrame(render);
      }
    },
  };
}
