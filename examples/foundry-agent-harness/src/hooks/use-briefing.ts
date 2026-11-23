import { useKeyboard } from "@opentui/react";
import { useCallback, useState } from "react";
import type { Context } from "@/model/context";
import {
  BRIEFING_STOPS,
  nudge,
  pick,
  type Rail,
  refocus,
  startRail,
} from "@/model/rail";

export function useBriefing(
  context: Context,
  avatars: number
): { readonly choose: (avatar: number) => void; readonly rail: Rail } {
  const [rail, setRail] = useState(() =>
    startRail(context, { focus: "avatar" })
  );
  useKeyboard((key) => {
    if (key.name === "tab") {
      setRail((current) => refocus(current, BRIEFING_STOPS, key.shift));
    }
    if (key.name === "up" || key.name === "down") {
      setRail((current) => refocus(current, BRIEFING_STOPS, key.name === "up"));
    }
    if (key.name === "left" || key.name === "right") {
      setRail((current) =>
        nudge(current, BRIEFING_STOPS, key.name === "right", {
          avatars,
          context,
        })
      );
    }
  });
  const choose = useCallback((avatar: number) => {
    setRail((current) => pick(current, avatar));
  }, []);
  return { choose, rail };
}
