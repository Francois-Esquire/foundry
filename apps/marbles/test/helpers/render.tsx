import { testRender } from "@opentui/react/test-utils";
import { sleep } from "bun";
import type { ReactNode } from "react";
import { act } from "react";

export type Rendered = Awaited<ReturnType<typeof testRender>>;

let current: Rendered | undefined;

export async function flush(ui: Rendered) {
  // Layout measurements update panel heights, then React commits the new sizes.
  await act(async () => ui.flush());
  await act(async () => ui.flush());
}

/**
 * Render with the keyboard protocol the dashboard expects, replacing the last
 * render; `unmount` cleans up after a test.
 */
export async function mount(
  node: ReactNode,
  { width = 120, height = 40 }: { width?: number; height?: number } = {}
): Promise<Rendered> {
  await unmount();
  current = await testRender(node, {
    exitOnCtrlC: false,
    height,
    kittyKeyboard: true,
    width,
  });
  await flush(current);
  return current;
}

export async function unmount() {
  await act(async () => {
    current?.renderer.destroy();
  });
  current = undefined;
}

export async function press(ui: Rendered, key: string) {
  await act(async () => {
    ui.mockInput.pressKey(key);
  });
  await flush(ui);
}

export async function click(ui: Rendered, id: string) {
  const target = ui.renderer.root.findDescendantById(id);
  if (!target) {
    throw new Error(`Missing ${id}`);
  }
  await act(async () => {
    await ui.mockMouse.click(target.x, target.y);
  });
  await flush(ui);
}

export async function ctrlC(ui: Rendered) {
  await act(async () => ui.mockInput.pressCtrlC());
  await flush(ui);
}

/** Markdown highlighting settles asynchronously after the first frame. */
export async function frameWith(ui: Rendered, text: string): Promise<string> {
  const deadline = Date.now() + 3000;
  for (;;) {
    await flush(ui);
    const frame = ui.captureCharFrame();
    if (frame.includes(text) || Date.now() > deadline) {
      return frame;
    }
    await sleep(25);
  }
}
