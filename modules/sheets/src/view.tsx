import { createRoot } from "react-dom/client";
import { loadWorkbooks } from "./composition";
import { SheetsApp } from "./editor/app";
import { ArtifactWorkbookHost } from "./editor/artifact-host";
import { EditorSession } from "./editor/session";

// The View's entry: one session for the page's lifetime, rendered by React.
// It is never closed; leaving the page ends it.
const root = document.getElementById("root");
if (!root) {
  throw new Error("Sheets root is missing");
}
const session = new EditorSession(
  new ArtifactWorkbookHost(),
  await loadWorkbooks(),
  new URLSearchParams(location.search).get("binding")
);
createRoot(root).render(<SheetsApp session={session} />);
// The session reports its own failures in its snapshot.
session.start().catch(() => undefined);
