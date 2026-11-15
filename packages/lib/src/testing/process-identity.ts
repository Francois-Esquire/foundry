import { thisProcess } from "../process-identity";

/**
 * A start of the kind this system reads, for a process that is not the
 * one `started` names: one from another boot under `/proc`, one at the
 * epoch under `ps`. For a test that models a pid handed to another
 * process since, as after a reboot.
 */
export function anotherStart(
  started: string | null = thisProcess().started
): string {
  if (started?.startsWith("linux:")) {
    const ticks = started.slice(started.lastIndexOf(":") + 1);
    return `linux:00000000-0000-0000-0000-000000000000:${ticks}`;
  }
  return "ps:Thu Jan 1 00:00:00 1970";
}
