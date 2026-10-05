import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { PreviewStartup } from "./startup";

const renderer = await createCliRenderer({ exitOnCtrlC: false });
const closed = new Promise<void>((resolve) =>
  renderer.once("destroy", resolve)
);
function close() {
  renderer.destroy();
}
try {
  createRoot(renderer).render(<PreviewStartup onClose={close} />);
  await closed;
} finally {
  renderer.destroy();
}
