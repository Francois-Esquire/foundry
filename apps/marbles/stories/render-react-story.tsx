import { BoxRenderable, type CliRenderer } from "@opentui/core";
import { createPortal, createRoot, flushSync } from "@opentui/react";
import { type ReactNode, type ReactPortal, useSyncExternalStore } from "react";

function createStoryMount(renderer: CliRenderer) {
  let current: { box: BoxRenderable; content: ReactNode } | null = null;
  let notify: (() => void) | undefined;

  function subscribe(listener: () => void) {
    notify = listener;
    return () => {
      notify = undefined;
    };
  }

  function getSnapshot() {
    return current;
  }

  function StoryPortal() {
    const story = useSyncExternalStore(subscribe, getSnapshot);
    return story
      ? (createPortal(story.content, story.box, null) as unknown as ReactPortal)
      : null;
  }

  class StoryBox extends BoxRenderable {
    override destroyRecursively() {
      try {
        if (current?.box === this) {
          current = null;
          flushSync(() => notify?.());
        }
      } finally {
        super.destroyRecursively();
      }
    }
  }

  const workshopChildren = renderer.root.getChildren();
  const root = createRoot(renderer);
  try {
    flushSync(() => root.render(<StoryPortal />));
  } finally {
    for (const child of workshopChildren) {
      if (child.parent !== renderer.root) {
        renderer.root.add(child);
      }
    }
  }

  return (content: ReactNode) => {
    const box = new StoryBox(renderer, {
      focusable: true,
      height: "100%",
      width: "100%",
    });
    current = { box, content };
    flushSync(() => notify?.());
    return box;
  };
}

const mounts = new WeakMap<CliRenderer, ReturnType<typeof createStoryMount>>();

export function renderReactStory(renderer: CliRenderer, content: ReactNode) {
  let mount = mounts.get(renderer);
  if (!mount) {
    mount = createStoryMount(renderer);
    mounts.set(renderer, mount);
  }
  return mount(content);
}
