import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { useWound } from "@/hooks/use-wound";
import { HEALTH } from "@/model/sprite";

function step(index: number, by: number, count: number): number {
  return Math.min(Math.max(index + by, 0), count - 1);
}

export function useAvatarBooth(avatars: number, frame: number) {
  const [selected, setSelected] = useState(0);
  const [severity, setSeverity] = useState(0);
  const health = HEALTH[severity] ?? "fresh";
  const { hit, hurtAt } = useWound(health, frame);
  useKeyboard((key) => {
    if (key.name === "left" || key.name === "right") {
      const by = key.name === "left" ? avatars - 1 : 1;
      setSelected((current) => (current + by) % avatars);
    }
    if (key.name === "up" || key.name === "down") {
      const by = key.name === "up" ? -1 : 1;
      setSeverity((current) => step(current, by, HEALTH.length));
    }
    if (key.name === "space") {
      hit();
    }
  });
  return { health, hurtAt, selected };
}
