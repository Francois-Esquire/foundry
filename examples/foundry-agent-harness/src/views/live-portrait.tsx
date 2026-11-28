import { useState } from "react";
import { Portrait } from "@/components/blocks/portrait";
import { useAnimationClock } from "@/hooks/use-animation-clock";
import { usePortrait } from "@/hooks/use-portrait";
import { useWound } from "@/hooks/use-wound";
import type { Avatar } from "@/model/avatars";
import type { Health, PortraitSize } from "@/model/sprite";

export function LivePortrait({
  avatar,
  health,
  seed,
  size,
  struckAt = null,
}: {
  readonly avatar: Avatar;
  readonly health: Health;
  readonly seed: number;
  readonly size?: PortraitSize;
  readonly struckAt?: number | null;
}) {
  const { frame } = useAnimationClock(true);
  const { hit, hurtAt } = useWound(health, frame);
  const [seen, setSeen] = useState(struckAt);
  if (seen !== struckAt) {
    setSeen(struckAt);
    if (struckAt !== null) {
      hit();
    }
  }
  const image = usePortrait({ avatar, frame, health, hurtAt, seed });
  return <Portrait image={image} size={size} />;
}
