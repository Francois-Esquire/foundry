import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { close, context, run } from "@/harness";
import { AppView } from "@/views/app";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  onDestroy: () => {
    close().catch(() => undefined);
  },
});
createRoot(renderer).render(<AppView context={context} run={run} />);
