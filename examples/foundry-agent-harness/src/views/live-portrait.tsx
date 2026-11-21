import { Portrait } from "@/components/blocks/portrait";
import { usePortrait } from "@/hooks/use-portrait";
import type { PortraitMoment } from "@/model/portrait";

export function LivePortrait(moment: PortraitMoment) {
  return <Portrait image={usePortrait(moment)} />;
}
