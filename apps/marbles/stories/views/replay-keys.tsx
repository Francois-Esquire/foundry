import { type BoxRenderable, KeyEvent, type Renderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";

export interface StoryKey {
  readonly ctrl?: boolean;
  readonly name: string;
  readonly sequence?: string;
  readonly shift?: boolean;
}

const NAMED: Readonly<Record<string, string>> = {
  down: "\u001b[B",
  enter: "\r",
  escape: "\u001b",
  left: "\u001b[D",
  return: "\r",
  right: "\u001b[C",
  space: " ",
  tab: "\t",
  up: "\u001b[A",
};

function storyKey(key: string | StoryKey): StoryKey {
  if (typeof key !== "string") {
    return key;
  }
  if (Object.hasOwn(NAMED, key)) {
    return { name: key, sequence: NAMED[key] };
  }
  const lower = key.toLowerCase();
  return lower === key
    ? { name: key, sequence: key }
    : { name: lower, sequence: key, shift: true };
}

function replayed(key: StoryKey) {
  const sequence = key.sequence ?? key.name;
  const event = new KeyEvent({
    ctrl: key.ctrl ?? false,
    eventType: "press",
    meta: false,
    name: key.name,
    number: false,
    option: false,
    raw: sequence,
    sequence,
    shift: key.shift ?? false,
    source: "raw",
  });
  return Object.assign(event, { replay: true });
}

function inside(node: Renderable | null, root: BoxRenderable | null) {
  for (let current = node; current; current = current.parent) {
    if (current === root) {
      return true;
    }
  }
  return false;
}

export function ReplayKeys({
  children,
  keys,
}: {
  readonly children: ReactNode;
  readonly keys: readonly (string | StoryKey)[];
}) {
  const renderer = useRenderer();
  const root = useRef<BoxRenderable>(null);
  const [step, setStep] = useState(0);
  useEffect(() => {
    const key = keys[step];
    if (key === undefined) {
      return;
    }
    const focused = renderer.currentFocusedRenderable;
    const outside = focused && !inside(focused, root.current) ? focused : null;
    outside?.blur();
    renderer.keyInput.emit("keypress", replayed(storyKey(key)));
    outside?.focus();
    setStep(step + 1);
  }, [renderer, keys, step]);
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} ref={root}>
      {children}
    </box>
  );
}
