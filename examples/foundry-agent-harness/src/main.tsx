import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "@/app";
import { close, context, run } from "@/harness";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  onDestroy: () => {
    close().catch(() => undefined);
  },
});
createRoot(renderer).render(<App context={context} run={run} />);
