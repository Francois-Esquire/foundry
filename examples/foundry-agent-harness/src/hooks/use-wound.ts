import { useCallback, useState } from "react";
import { HEALTH, type Health } from "@/model/sprite";

export function useWound(health: Health, frame: number) {
  const [seen, setSeen] = useState<{
    readonly health: Health;
    readonly hurtAt: number | null;
  }>({ health, hurtAt: null });
  if (seen.health !== health) {
    const worse = HEALTH.indexOf(health) > HEALTH.indexOf(seen.health);
    setSeen({ health, hurtAt: worse ? frame : seen.hurtAt });
  }
  const hit = useCallback(
    () => setSeen((current) => ({ ...current, hurtAt: frame })),
    [frame]
  );
  return { hit, hurtAt: seen.hurtAt };
}
