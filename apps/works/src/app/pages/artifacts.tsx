import { useCallback } from "react";
import { useNavigate, useParams } from "react-router";
import { ArtifactExplorer } from "~/app/artifacts/artifact-explorer";
import { NewMarkdownFile } from "~/app/artifacts/new-markdown-file";
import { VignettePage } from "~/app/layout/page-vignette";

/** `/artifacts`, or `/artifacts/:artifactId` to open one Artifact by ID. */
export function ArtifactsPage() {
  const { artifactId } = useParams<{ artifactId: string }>();
  const navigate = useNavigate();
  const back = useCallback(
    () => navigate("/artifacts", { replace: true }),
    [navigate]
  );
  return (
    <VignettePage viewportClassName="relative min-h-full">
      <div className="mx-auto w-full max-w-5xl px-8 py-10">
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-sans font-semibold text-3xl tracking-tight">
            Artifacts
          </h1>
          <NewMarkdownFile />
        </div>
        <p className="mt-3 mb-8 text-muted-foreground text-sm">
          Your files and everything your modules have made, stored on this
          device.
        </p>
        <ArtifactExplorer onRequestDone={back} requested={artifactId} />
      </div>
    </VignettePage>
  );
}
