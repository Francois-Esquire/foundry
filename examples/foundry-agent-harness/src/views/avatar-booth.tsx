import { AvatarBooth } from "@/components/layouts/avatar-booth";
import { useAnimationClock } from "@/hooks/use-animation-clock";
import { useAvatarBooth } from "@/hooks/use-avatar-booth";
import { avatars } from "@/model/avatars";

export function AvatarBoothView() {
  const { frame } = useAnimationClock(true);
  const booth = useAvatarBooth(avatars.length, frame);
  return <AvatarBooth avatars={avatars} frame={frame} {...booth} />;
}
