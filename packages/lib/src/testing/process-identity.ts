import { thisProcess } from "../node/process-identity";

export function anotherStart(
  started: string | null = thisProcess().started
): string {
  if (started?.startsWith("linux:")) {
    const ticks = started.slice(started.lastIndexOf(":") + 1);
    return `linux:00000000-0000-0000-0000-000000000000:${ticks}`;
  }
  return "ps:Thu Jan 1 00:00:00 1970";
}
