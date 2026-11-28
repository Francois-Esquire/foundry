import { useState } from "react";
import type { Picks } from "@/model/rail";

export function useMission(): {
  readonly begin: (picks: Picks) => void;
  readonly picks: Picks | null;
} {
  const [picks, begin] = useState<Picks | null>(null);
  return { begin, picks };
}
