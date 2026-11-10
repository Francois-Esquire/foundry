import { useEffect } from "react";
import { useWorkspace } from "~/workspace/react";

/**
 * The project is held in memory only, so leaving or reloading the page
 * empties it. While it holds any imported font the browser is asked to
 * check with the person first. An empty project has nothing to lose.
 */
export function UnloadGuard() {
  const workspace = useWorkspace();
  useEffect(() => {
    const ask = (event: BeforeUnloadEvent) => {
      if (workspace.getState().project.sources.length > 0) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [workspace]);
  return null;
}
