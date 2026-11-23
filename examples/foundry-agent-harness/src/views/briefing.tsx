import {
  BriefingLayout,
  briefingGeometry,
} from "@/components/layouts/briefing";
import { useBriefing } from "@/hooks/use-briefing";
import { useConfirm } from "@/hooks/use-confirm";
import { ThemeContext } from "@/hooks/use-theme";
import { useViewport } from "@/hooks/use-viewport";
import { avatars } from "@/model/avatars";
import type { Context } from "@/model/context";
import type { Picks } from "@/model/rail";
import { amberTheme } from "@/model/theme";
import { LivePortrait } from "@/views/live-portrait";

const THEME = { setTheme: () => undefined, theme: amberTheme };

export function BriefingView({
  context,
  onStart,
}: {
  readonly context: Context;
  readonly onStart: (picks: Picks) => void;
}) {
  const { measure, size } = useViewport();
  const { choose, rail } = useBriefing(context, avatars.length);
  const { avatar, effort, model } = rail;
  useConfirm(() => onStart({ avatar, effort, model }));
  const { portrait } = briefingGeometry(size, avatars.length);
  return (
    <ThemeContext.Provider value={THEME}>
      <BriefingLayout
        avatars={avatars}
        context={context}
        onPick={choose}
        onResize={measure}
        portraits={avatars.map((each, index) => (
          <LivePortrait
            avatar={each}
            health="fresh"
            key={each.name}
            seed={index + 1}
            size={portrait}
          />
        ))}
        rail={rail}
        size={size}
      />
    </ThemeContext.Provider>
  );
}
