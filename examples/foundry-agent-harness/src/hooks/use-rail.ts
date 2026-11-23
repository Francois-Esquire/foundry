import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import type { Context } from "@/model/context";
import {
  adjust,
  type Rail,
  type RailStop,
  refocus,
  startRail,
} from "@/model/rail";

export function useRail(
  context: Context,
  avatars: number,
  stops: readonly RailStop[],
  from?: Partial<Rail>
): Rail {
  const [rail, setRail] = useState(() => startRail(context, from));
  useKeyboard((key) => {
    if (key.name === "tab") {
      setRail((current) => refocus(current, stops, key.shift));
    }
    if (key.name === "up" || key.name === "down") {
      const by = key.name === "up" ? -1 : 1;
      setRail((current) => adjust(current, stops, by, { avatars, context }));
    }
  });
  return rail;
}
