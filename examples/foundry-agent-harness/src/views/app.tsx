import { useMission } from "@/hooks/use-mission";
import type { Context } from "@/model/context";
import type { Run } from "@/model/thread";
import { BriefingView } from "@/views/briefing";
import { HarnessView } from "@/views/harness";

export function AppView({
  context,
  run,
}: {
  readonly context: Context;
  readonly run: Run;
}) {
  const { begin, picks } = useMission();
  return picks ? (
    <HarnessView context={context} picks={picks} run={run} />
  ) : (
    <BriefingView context={context} onStart={begin} />
  );
}
