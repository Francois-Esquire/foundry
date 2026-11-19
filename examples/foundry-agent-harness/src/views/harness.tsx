import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useRef, useState } from "react";
import { Conversation } from "@/components/blocks/conversation";
import { GoalBar } from "@/components/blocks/goal-bar";
import { SidePanel } from "@/components/blocks/side-panel";
import { StatusLine } from "@/components/blocks/status-line";
import { ThreadHeader } from "@/components/blocks/thread-header";
import { Panel } from "@/components/ui/panel";
import type { Context } from "@/model/context";
import type { Thread } from "@/model/thread";
import { isBusy } from "@/model/thread";

const SIDE_WIDTH = 42;
const CONVERSATION_MIN_WIDTH = 30;
const GOAL_BAR_HEIGHT = 3;
const STATUS_HEIGHT = 1;
const HEADER_HEIGHT = 1;
const PANEL_BORDER = 2;
const PAGE_OVERLAP = 3;

export function HarnessView({
  context,
  onGoal,
  thread,
}: {
  readonly context: Context;
  readonly onGoal: (goal: string) => void;
  readonly thread: Thread;
}) {
  const terminal = useTerminalDimensions();
  const [viewport, setViewport] = useState<typeof terminal>();
  const { height, width } = viewport ?? terminal;
  const measure = useCallback(function measureHarness(this: BoxRenderable) {
    setViewport({ height: this.height, width: this.width });
  }, []);
  const scroll = useRef<ScrollBoxRenderable>(null);
  const body = height - GOAL_BAR_HEIGHT - STATUS_HEIGHT;
  const side = width < SIDE_WIDTH + CONVERSATION_MIN_WIDTH ? 0 : SIDE_WIDTH;
  const page = body - HEADER_HEIGHT - PANEL_BORDER - PAGE_OVERLAP;

  useKeyboard((key) => {
    if (key.name === "pageup" || key.name === "pagedown") {
      scroll.current?.scrollBy(key.name === "pageup" ? -page : page);
    }
  });

  return (
    <box
      flexDirection="column"
      height="100%"
      onSizeChange={measure}
      width="100%"
    >
      <box flexDirection="row">
        {side > 0 && (
          <box flexDirection="column" height={body} width={side}>
            <SidePanel context={context} thread={thread} />
          </box>
        )}
        <box flexDirection="column" height={body} width={width - side}>
          <ThreadHeader
            model={context.model}
            title={thread.title}
            width={width - side}
          />
          <Panel height={body - HEADER_HEIGHT} width={width - side}>
            <scrollbox
              contentOptions={{ paddingRight: 1 }}
              height={body - HEADER_HEIGHT - PANEL_BORDER}
              ref={scroll}
              stickyScroll
              stickyStart="bottom"
            >
              <Conversation messages={thread.messages} />
            </scrollbox>
          </Panel>
        </box>
      </box>
      <GoalBar busy={isBusy(thread)} onGoal={onGoal} width={width} />
      <StatusLine
        input={thread.input}
        output={thread.output}
        panel={side > 0}
      />
    </box>
  );
}
