import { HudLayout, hudGeometry } from "@/components/layouts/hud";
import { useAnimationClock } from "@/hooks/use-animation-clock";
import { useGoalDraft } from "@/hooks/use-goal-draft";
import { usePageScroll } from "@/hooks/use-page-scroll";
import { useRail } from "@/hooks/use-rail";
import { ThemeContext } from "@/hooks/use-theme";
import { useThread } from "@/hooks/use-thread";
import { useViewport } from "@/hooks/use-viewport";
import { avatars } from "@/model/avatars";
import type { Context } from "@/model/context";
import { healthAt } from "@/model/sprite";
import { amberTheme } from "@/model/theme";
import type { Run } from "@/model/thread";
import { contextUsed, hasFailed, isAnimating, isBusy } from "@/model/thread";
import { LivePortrait } from "@/views/live-portrait";

const THEME = { setTheme: () => undefined, theme: amberTheme };

export function HarnessView({
  context,
  run,
}: {
  readonly context: Context;
  readonly run: Run;
}) {
  const { start, thread } = useThread(run);
  const { measure, size } = useViewport();
  const { page, portrait, stops } = hudGeometry(size);
  const scroll = usePageScroll(page);
  const rail = useRail(context, avatars.length, stops);
  const { effort, model } = rail;
  const goal = useGoalDraft({
    busy: isBusy(thread),
    onGoal: (text) => start(text, { effort, model }),
  });
  const clock = useAnimationClock(isAnimating(thread));
  const avatar = avatars[rail.avatar] ?? avatars[0];
  return (
    <ThemeContext.Provider value={THEME}>
      <HudLayout
        avatar={avatar.name}
        clock={clock}
        context={context}
        draft={goal.draft}
        onDraft={goal.setDraft}
        onResize={measure}
        onSubmit={goal.submit}
        portrait={
          <LivePortrait
            avatar={avatar}
            health={healthAt(contextUsed(thread, context.limit))}
            seed={rail.avatar + 1}
            size={portrait}
            struckAt={hasFailed(thread) ? thread.messages.length : null}
          />
        }
        rail={rail}
        scrollRef={scroll}
        size={size}
        thread={thread}
      />
    </ThemeContext.Provider>
  );
}
