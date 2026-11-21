import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { HEALTH } from "@/model/sprite";

export function useAvatarBooth(avatars: number) {
  const [selected, setSelected] = useState(0);
  const [severity, setSeverity] = useState(0);
  const [hits, setHits] = useState(0);
  useKeyboard((key) => {
    if (key.name === "left" || key.name === "right") {
      const by = key.name === "left" ? avatars - 1 : 1;
      setSelected((current) => (current + by) % avatars);
    }
    if (key.name === "up" || key.name === "down") {
      const by = key.name === "up" ? -1 : 1;
      setSeverity((current) =>
        Math.min(Math.max(current + by, 0), HEALTH.length - 1)
      );
    }
    if (key.name === "space") {
      setHits((current) => current + 1);
    }
  });
  return { health: HEALTH[severity] ?? "fresh", hits, selected };
}
