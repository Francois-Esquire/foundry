import { AvatarBooth } from "@/components/layouts/avatar-booth";
import { useAnimationClock } from "@/hooks/use-animation-clock";
import { useAvatarBooth } from "@/hooks/use-avatar-booth";
import { avatars } from "@/model/avatars";
import { LivePortrait } from "@/views/live-portrait";

export function AvatarBoothView() {
  const { frame } = useAnimationClock(true);
  const { health, hurtAt, selected } = useAvatarBooth(avatars.length, frame);
  return (
    <AvatarBooth
      avatars={avatars}
      health={health}
      portraits={avatars.map((avatar, index) => (
        <LivePortrait
          avatar={avatar}
          frame={frame}
          health={health}
          hurtAt={hurtAt}
          key={avatar.name}
          seed={index + 1}
        />
      ))}
      selected={selected}
    />
  );
}
