interface ProfileSession {
  evaluate: (expression: string) => Promise<unknown>;
  send: (method: string, params?: object) => Promise<unknown>;
}

type Interaction = "pan" | "pointer" | "sweep" | "zoom";

/** Serialized into the page by the capture tool; no dependencies outside this function. */
async function measureInteraction(kind: Interaction, x: number, y: number) {
  const canvas = document.querySelector("canvas");
  if (!canvas) {
    throw new Error("Missing atlas canvas");
  }
  const changes: unknown[] = [];
  const longTasks: { milliseconds: number; start: number }[] = [];
  const started = performance.now();
  const record = (event: Event) =>
    changes.push({
      at: performance.now() - started,
      status: (event as CustomEvent<unknown>).detail,
    });
  document.addEventListener("atlas:render", record, true);
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longTasks.push({
        milliseconds: entry.duration,
        start: entry.startTime - started,
      });
    }
  });
  observer.observe({ entryTypes: ["longtask"] });
  const dispatch: number[] = [];
  const frames: number[] = [];
  const stalls: { frame: number; milliseconds: number }[] = [];
  const sweeping = kind === "sweep";
  const count = sweeping ? 480 : 120;
  const dispatchInput = (index: number) => {
    if (kind === "zoom" || sweeping) {
      const direction = sweeping ? Math.floor(index / 160) : index;
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          deltaY: direction % 2 ? 40 : -40,
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
  };
  let previous = performance.now();
  for (let index = 0; index < count + (sweeping ? 60 : 0); index += 1) {
    await new Promise(requestAnimationFrame);
    const now = performance.now();
    const began = performance.now();
    if (index < count) {
      dispatchInput(index);
    }
    if (sweeping || index >= 20) {
      if (index < count) {
        dispatch.push(performance.now() - began);
      }
      frames.push(now - previous);
      if (now - previous > 50) {
        stalls.push({ frame: index, milliseconds: now - previous });
      }
    }
    previous = now;
  }
  observer.disconnect();
  document.removeEventListener("atlas:render", record, true);
  const stats = (values: number[]) => {
    values.sort((a, b) => a - b);
    return {
      max: values.at(-1) ?? 0,
      mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      p50: values[Math.floor(values.length * 0.5)] ?? 0,
      p95: values[Math.floor(values.length * 0.95)] ?? 0,
    };
  };
  return {
    changes,
    dispatchMs: stats(dispatch),
    frameMs: stats(frames),
    longTasks,
    stalls,
  };
}

/** Real canvas handlers and Chrome CPU samples, including native pointer capture for panning. */
export async function profileInteraction(
  session: ProfileSession,
  input: string
) {
  const [kind, coordinates] = input.split("@");
  const [x = kind === "sweep" ? 510 : 750, y = kind === "sweep" ? 810 : 530] =
    coordinates?.split(",").map(Number) ?? [];
  if (!(Number.isFinite(x) && Number.isFinite(y))) {
    throw new Error("Profile coordinates must be finite numbers");
  }
  if (
    kind !== "pan" &&
    kind !== "zoom" &&
    kind !== "pointer" &&
    kind !== "sweep"
  ) {
    throw new Error("Profile must be pan, zoom, pointer or sweep");
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
    `(${measureInteraction.toString()})(${JSON.stringify(kind)}, ${x}, ${y})`
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
    passed:
      metrics.dispatchMs.p95 < budget &&
      metrics.frameMs.p95 < 35 &&
      (kind !== "sweep" || metrics.frameMs.max < 100),
    profile,
  };
}
