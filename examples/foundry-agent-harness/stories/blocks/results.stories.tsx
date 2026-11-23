import { defineStories, story } from "textbook-sh";
import { Plate } from "@/components/blocks/plate";
import { Results, resultsMeta } from "@/components/blocks/results";
import type { Scorecard } from "@/game/scorecard";
import { hud } from "@/model/palette";
import { scorecards } from "../fixtures/threads";
import { renderFrame } from "../frame";

const size = { height: 6, width: 84 };

export default defineStories({
  component: "Results",
  description:
    "The results card for the latest encounter: its facts, then the verdict and the XP it earned.",
  title: "Blocks/Results",
});

function card(name: string, description: string, scorecard: Scorecard) {
  return story({
    description,
    name,
    render: (renderer) =>
      renderFrame(
        renderer,
        <Plate
          icon="★"
          meta={resultsMeta(scorecard)}
          title="RESULTS"
          tone={scorecard.verdict === null ? hud.amber : hud.bronze}
        >
          <Results scorecard={scorecard} />
        </Plate>,
        size
      ),
  });
}

export const Pending = card(
  "Pending",
  "Finished and waiting for A, R or Esc.",
  scorecards.pending
);

export const Accepted = card(
  "Accepted",
  "Accepted: the rank, each line item and the total.",
  scorecards.accepted
);

export const Rejected = card(
  "Rejected",
  "Rejected: nothing is banked.",
  scorecards.rejected
);

export const Consoled = card(
  "Failed, accepted",
  "A failed encounter accepted for the consolation amount.",
  scorecards.consoled
);
