import { useQuery } from "@tanstack/react-query";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { worksApi } from "~/app/api/client";
import { Button } from "~/app/components/button";
import { moveFocusAmong } from "~/app/lib/focus";
import type { ArtifactSummary } from "~/shared/artifacts";
import {
  type ArtifactOpener,
  ArtifactOpenerDialog,
  useArtifactOpener,
} from "./artifact-opener";
import { artifactKind } from "./artifact-type";

const updatedFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const CARD = "[data-artifact-open]";

/** Columns of the laid-out grid; 1 when there is no layout to read. */
function columnsOf(grid: Element): number {
  const tracks = getComputedStyle(grid)
    .gridTemplateColumns.split(" ")
    .filter((track) => track.endsWith("px")).length;
  return Math.max(tracks, 1);
}

/**
 * Arrow keys move between cards (up/down by a row), Home/End to the ends.
 * Every card stays in the Tab order.
 */
function moveFocus(event: KeyboardEvent<HTMLButtonElement>) {
  const grid = event.currentTarget.closest("ul");
  if (grid) {
    moveFocusAmong(event, [...grid.querySelectorAll<HTMLElement>(CARD)], {
      columns: columnsOf(grid),
    });
  }
}

function ArtifactPreview({ artifact }: { artifact: ArtifactSummary }) {
  const { icon: Icon } = artifactKind(artifact);
  const thumbnail = useQuery({
    ...worksApi().artifacts.thumbnail.queryOptions({
      input: { id: artifact.id },
    }),
    enabled: artifact.thumbnail,
  });
  const [broken, setBroken] = useState(false);
  const fail = useCallback(() => setBroken(true), []);
  const url = broken ? undefined : thumbnail.data?.url;
  return (
    <div
      aria-hidden="true"
      className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg bg-muted/50"
      data-preview={url ? "thumbnail" : "icon"}
    >
      {url ? (
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: a load failure, not a user interaction.
        <img
          alt=""
          className="size-full object-cover"
          height={150}
          onError={fail}
          src={url}
          width={200}
        />
      ) : (
        <Icon className="size-10 text-muted-foreground" />
      )}
    </div>
  );
}

function ArtifactCard({
  artifact,
  opener,
}: {
  artifact: ArtifactSummary;
  opener: ArtifactOpener;
}) {
  const { label } = artifactKind(artifact);
  const { open, openWith } = opener;
  const onOpen = useCallback(() => open(artifact.id), [artifact.id, open]);
  const onOpenWith = useCallback(
    () => openWith(artifact.id),
    [artifact.id, openWith]
  );
  return (
    <li className="relative flex flex-col gap-2 rounded-xl border border-border p-3 focus-within:border-ring">
      <ArtifactPreview artifact={artifact} />
      <h2 className="truncate font-medium text-sm">
        {/* The card's whole surface opens it; the button carries the name. */}
        <button
          className="rounded-xl outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
          data-artifact-open=""
          onClick={onOpen}
          onKeyDown={moveFocus}
          type="button"
        >
          {artifact.name}
        </button>
      </h2>
      <p className="truncate text-muted-foreground text-xs">
        <span title={artifact.type}>{label}</span>
        {artifact.files > 1 ? ` · ${artifact.files} files` : ""}
      </p>
      <div className="flex items-center justify-between gap-2">
        <time
          className="truncate text-muted-foreground text-xs"
          dateTime={artifact.updatedAt}
        >
          Updated {updatedFormat.format(new Date(artifact.updatedAt))}
        </time>
        <Button
          aria-label={`Open ${artifact.name} with…`}
          className="relative z-10"
          onClick={onOpenWith}
          size="xs"
          variant="ghost"
        >
          Open with…
        </Button>
      </div>
    </li>
  );
}

/**
 * Product Artifacts in the shared store as a grid; Module Artifacts are left
 * out. `requested` opens one Artifact by ID, a Module Artifact included.
 */
export function ArtifactExplorer({
  onRequestDone,
  requested,
}: {
  /** Told when the user dismisses the requested Artifact's dialog. */
  onRequestDone?: () => void;
  requested?: string;
}) {
  const list = useArtifactList();
  const opener = useArtifactOpener();
  const retry = useCallback(() => {
    list.refetch().catch(() => undefined);
  }, [list.refetch]);
  const { close, open } = opener;
  const opened = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (requested !== opened.current) {
      opened.current = requested;
      if (requested) {
        open(requested);
      }
    }
  }, [open, requested]);
  const dismiss = useCallback(() => {
    close();
    if (requested) {
      onRequestDone?.();
    }
  }, [close, onRequestDone, requested]);
  return (
    <>
      <ArtifactGrid list={list} opener={opener} retry={retry} />
      <ArtifactOpenerDialog opener={{ ...opener, close: dismiss }} />
    </>
  );
}

function ArtifactGrid({
  list,
  opener,
  retry,
}: {
  list: ReturnType<typeof useArtifactList>;
  opener: ArtifactOpener;
  retry: () => void;
}) {
  if (list.isPending) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        Loading artifacts…
      </p>
    );
  }
  if (list.error) {
    return (
      <div className="space-y-3 text-sm" role="alert">
        <p>{list.error.message}</p>
        <Button onClick={retry} variant="outline">
          Try again
        </Button>
      </div>
    );
  }
  if (list.data.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No artifacts yet. Create a Markdown file, or files your modules create
        appear here.
      </p>
    );
  }
  return (
    <ul
      aria-label="Artifact list"
      className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3"
    >
      {list.data.map((artifact) => (
        <ArtifactCard artifact={artifact} key={artifact.id} opener={opener} />
      ))}
    </ul>
  );
}

function useArtifactList() {
  return useQuery(worksApi().artifacts.list.queryOptions());
}
