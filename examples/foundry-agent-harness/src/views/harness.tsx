import { SIDE_TABS } from "@/components/blocks/side-panel";
import { HarnessLayout, harnessGeometry } from "@/components/layouts/harness";
import { useAnimationClock } from "@/hooks/use-animation-clock";
import { useGoalDraft } from "@/hooks/use-goal-draft";
import { usePageScroll } from "@/hooks/use-page-scroll";
import { useTabCycle } from "@/hooks/use-tab-cycle";
import { useThread } from "@/hooks/use-thread";
import { useViewport } from "@/hooks/use-viewport";
import type { Context } from "@/model/context";
import type { Run } from "@/model/thread";
import { isAnimating, isBusy } from "@/model/thread";

export function HarnessView({
  context,
  run,
}: {
  readonly context: Context;
  readonly run: Run;
}) {
  const { start, thread } = useThread(run);
  const { measure, size } = useViewport();
  const { page, side } = harnessGeometry(size);
  const scroll = usePageScroll(page);
  const activeTab = useTabCycle(SIDE_TABS, side > 0);
  const goal = useGoalDraft({ busy: isBusy(thread), onGoal: start });
  const clock = useAnimationClock(isAnimating(thread));
  return (
    <HarnessLayout
      activeTab={activeTab}
      clock={clock}
      context={context}
      draft={goal.draft}
      onDraft={goal.setDraft}
      onResize={measure}
      onSubmit={goal.submit}
      scrollRef={scroll}
      size={size}
      thread={thread}
    />
  );
}
