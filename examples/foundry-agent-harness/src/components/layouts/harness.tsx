import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { type Ref, useCallback } from "react";
import { Conversation } from "@/components/blocks/conversation";
import { GoalBar } from "@/components/blocks/goal-bar";
import { SidePanel, type SideTab } from "@/components/blocks/side-panel";
import { StatusLine } from "@/components/blocks/status-line";
import { ThreadHeader } from "@/components/blocks/thread-header";
import { Panel } from "@/components/ui/panel";
import type { Context } from "@/model/context";
import type { Clock, Size } from "@/model/screen";
import type { Thread } from "@/model/thread";
import { isBusy } from "@/model/thread";

const SIDE_WIDTH = 42;
const CONVERSATION_MIN_WIDTH = 30;
const GOAL_BAR_HEIGHT = 3;
const STATUS_HEIGHT = 1;
const HEADER_HEIGHT = 1;
const PANEL_BORDER = 2;
const PAGE_OVERLAP = 3;

export function harnessGeometry({ height, width }: Size) {
  const body = height - GOAL_BAR_HEIGHT - STATUS_HEIGHT;
  const side = width < SIDE_WIDTH + CONVERSATION_MIN_WIDTH ? 0 : SIDE_WIDTH;
  return {
    body,
    main: width - side,
    page: body - HEADER_HEIGHT - PANEL_BORDER - PAGE_OVERLAP,
    side,
  };
}

export function HarnessLayout({
  activeTab,
  clock,
  context,
  draft,
  onDraft,
  onResize,
  onSubmit,
  scrollRef,
  size,
  thread,
}: {
  readonly activeTab: SideTab;
  readonly clock: Clock;
  readonly context: Context;
  readonly draft: string;
  readonly onDraft: (draft: string) => void;
  readonly onResize: (size: Size) => void;
  readonly onSubmit: () => void;
  readonly scrollRef?: Ref<ScrollBoxRenderable>;
  readonly size: Size;
  readonly thread: Thread;
}) {
  const { body, main, side } = harnessGeometry(size);
  const measure = useCallback(
    function measureHarness(this: BoxRenderable) {
      onResize({ height: this.height, width: this.width });
    },
    [onResize]
  );
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
            <SidePanel
              active={activeTab}
              context={context}
              frame={clock.frame}
              thread={thread}
            />
          </box>
        )}
        <box flexDirection="column" height={body} width={main}>
          <ThreadHeader
            model={context.model}
            title={thread.title}
            width={main}
          />
          <Panel height={body - HEADER_HEIGHT} width={main}>
            <scrollbox
              contentOptions={{ paddingRight: 1 }}
              height={body - HEADER_HEIGHT - PANEL_BORDER}
              ref={scrollRef}
              stickyScroll
              stickyStart="bottom"
            >
              <Conversation clock={clock} messages={thread.messages} />
            </scrollbox>
          </Panel>
        </box>
      </box>
      <GoalBar
        busy={isBusy(thread)}
        draft={draft}
        frame={clock.frame}
        onDraft={onDraft}
        onSubmit={onSubmit}
        width={size.width}
      />
      <StatusLine
        input={thread.input}
        output={thread.output}
        panel={side > 0}
      />
    </box>
  );
}
