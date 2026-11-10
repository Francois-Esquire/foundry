import { type MouseEvent, useCallback } from "react";
import type { Revision } from "~/typeface/changes";
import type { Candidate } from "~/typeface/project";
import { Button } from "~/ui/controls/button";
import { ScrollRegion } from "~/ui/layout/scroll-region";
import { revisionTitle } from "./revision-title";

interface HistoryPanelProps {
  /** The project's candidates, so a revision that accepted one can name its character. */
  readonly candidates?: readonly Candidate[];
  /** How many revisions are applied. */
  readonly head: number;
  readonly onCheckout: (head: number) => void;
  readonly onRedo: () => void;
  readonly onUndo: () => void;
  /** The label of an edit that is under way and not yet a revision. */
  readonly pending?: string;
  readonly revisions: readonly Revision[];
}

/**
 * Undo, redo and every revision of the project, newest first. Choosing a
 * revision steps the project to it: later revisions stay in the list, struck
 * through, until a new edit replaces them.
 */
export function HistoryPanel({
  candidates = [],
  head,
  onCheckout,
  onRedo,
  onUndo,
  pending,
  revisions,
}: HistoryPanelProps) {
  const step = useCallback(
    (event: MouseEvent<HTMLButtonElement>) =>
      onCheckout(Number(event.currentTarget.value)),
    [onCheckout]
  );
  return (
    <div className="ty-studio-history">
      <div className="ty-studio-row">
        <Button
          disabled={head === 0 && !pending}
          onClick={onUndo}
          symbol="undo"
        >
          Undo
        </Button>
        <Button
          disabled={head >= revisions.length}
          onClick={onRedo}
          symbol="redo"
        >
          Redo
        </Button>
      </div>
      <ScrollRegion label="Revisions">
        <ol
          className="ty-studio-revisions"
          data-head={head}
          data-revisions={revisions.length}
        >
          {pending ? (
            <li className="ty-carbon" data-pending="true">
              <span>{head + 1}</span>
              <span>{pending}</span>
              <span>in progress</span>
            </li>
          ) : null}
          {revisions
            .map((revision, index) => ({
              number: index + 1,
              revision,
              title: revisionTitle(revision, candidates),
            }))
            .reverse()
            .map(({ number, revision, title }) => (
              <li data-undone={number > head} key={revision.id}>
                <button
                  aria-current={number === head ? "step" : undefined}
                  aria-label={`Step to revision ${number}, ${title}${number > head ? ", undone" : ""}`}
                  onClick={step}
                  type="button"
                  value={number}
                >
                  <span>{number}</span>
                  <span>{title}</span>
                  <span>{number > head ? "undone" : ""}</span>
                </button>
              </li>
            ))}
          <li>
            <button
              aria-current={head === 0 ? "step" : undefined}
              aria-label="Step to the source fonts, unchanged"
              onClick={step}
              type="button"
              value={0}
            >
              <span>0</span>
              <span>Source fonts, unchanged</span>
              <span />
            </button>
          </li>
        </ol>
      </ScrollRegion>
    </div>
  );
}
