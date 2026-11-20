import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { close, context, run } from "@/harness";
import { HarnessView } from "@/views/harness";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  onDestroy: () => {
    close().catch(() => undefined);
  },
});
createRoot(renderer).render(<HarnessView context={context} run={run} />);
