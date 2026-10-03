interface ProfileSession {
  evaluate: (expression: string) => Promise<unknown>;
  send: (method: string, params?: object) => Promise<unknown>;
}

type Interaction = "pan" | "pointer" | "zoom";

/** Serialized into the page by the capture tool; no dependencies outside this function. */
async function measureInteraction(kind: Interaction) {
  const canvas = document.querySelector("canvas");
  if (!canvas) {
    throw new Error("Missing atlas canvas");
  }
  const dispatch: number[] = [];
  const frames: number[] = [];
  let previous = performance.now();
  for (let index = 0; index < 120; index += 1) {
    await new Promise(requestAnimationFrame);
    const now = performance.now();
    const began = performance.now();
    if (kind === "zoom") {
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: 750,
          clientY: 530,
          deltaY: index % 2 ? 40 : -40,
        })
      );
    } else {
      const pan = kind === "pan";
      canvas.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          buttons: pan ? 1 : 0,
          clientX: pan
            ? 750 + 80 * Math.sin(index / 12)
            : 450 + (index % 20) * 25,
          clientY: pan
            ? 530 + 45 * Math.cos(index / 12)
            : 420 + Math.floor(index / 20) * 28,
          pointerId: 1,
          pointerType: "mouse",
        })
      );
    }
    if (index >= 20) {
      dispatch.push(performance.now() - began);
      frames.push(now - previous);
    }
    previous = now;
  }
  const stats = (values: number[]) => {
    values.sort((a, b) => a - b);
    return {
      max: values.at(-1) ?? 0,
      mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      p50: values[50] ?? 0,
      p95: values[95] ?? 0,
    };
  };
  return { dispatchMs: stats(dispatch), frameMs: stats(frames) };
}

/** Real canvas handlers and Chrome CPU samples, including native pointer capture for panning. */
export async function profileInteraction(
  session: ProfileSession,
  kind: string
) {
  if (kind !== "pan" && kind !== "zoom" && kind !== "pointer") {
    throw new Error("Profile must be pan, zoom or pointer");
  }
  if (kind === "pan") {
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 750,
      y: 530,
    });
    await session.send("Input.dispatchMouseEvent", {
      button: "left",
      clickCount: 1,
      type: "mousePressed",
      x: 750,
      y: 530,
    });
  }
  await session.send("Profiler.enable");
  await session.send("Profiler.start");
  const metrics = (await session.evaluate(
    `(${measureInteraction.toString()})(${JSON.stringify(kind)})`
  )) as Awaited<ReturnType<typeof measureInteraction>>;
  const profile = await session.send("Profiler.stop");
  if (kind === "pan") {
    await session.send("Input.dispatchMouseEvent", {
      button: "left",
      clickCount: 1,
      type: "mouseReleased",
      x: 750 + 80 * Math.sin(119 / 12),
      y: 530 + 45 * Math.cos(119 / 12),
    });
  }
  const budget = kind === "pointer" ? 2 : 6;
  return {
    metrics,
    passed: metrics.dispatchMs.p95 < budget && metrics.frameMs.p95 < 35,
    profile,
  };
}
