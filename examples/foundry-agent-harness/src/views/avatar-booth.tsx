import { AvatarBooth } from "@/components/layouts/avatar-booth";
import { useAvatarBooth } from "@/hooks/use-avatar-booth";
import { avatars } from "@/model/avatars";
import { LivePortrait } from "@/views/live-portrait";

export function AvatarBoothView() {
  const { health, hits, selected } = useAvatarBooth(avatars.length);
  return (
    <AvatarBooth
      avatars={avatars}
      health={health}
      portraits={avatars.map((avatar, index) => (
        <LivePortrait
          avatar={avatar}
          health={health}
          key={avatar.name}
          seed={index + 1}
          struckAt={hits === 0 ? null : hits}
        />
      ))}
      selected={selected}
    />
  );
}
