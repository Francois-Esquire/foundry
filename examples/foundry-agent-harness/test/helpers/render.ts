import { testRender } from "@opentui/react/test-utils";
import { sleep } from "bun";
import type { ReactNode } from "react";
import { act } from "react";

export type Rendered = Awaited<ReturnType<typeof testRender>>;

let current: Rendered | undefined;

async function flush(ui: Rendered) {
  await act(async () => ui.flush());
  await act(async () => ui.flush());
}

export async function mount(
  node: ReactNode,
  { width = 120, height = 32 }: { width?: number; height?: number } = {}
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

export async function press(
  ui: Rendered,
  key: string,
  modifiers?: { shift?: boolean }
) {
  await act(async () => {
    ui.mockInput.pressKey(key, modifiers);
  });
  await flush(ui);
}

export async function type(ui: Rendered, text: string) {
  await act(async () => {
    await ui.mockInput.typeText(text);
  });
  await flush(ui);
}

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
