/** @vitest-environment happy-dom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { FamilyStrategyDetails } from "~/generate/family/family-strategy-details";
import { StrategyDetails } from "~/generate/strategy-details";
import { latoSession } from "./helpers/session";

afterEach(cleanup);

it("shows the same estimate for Generate and Family with one weight", async () => {
  const { workspace, faceId, session } = await latoSession();
  const face = workspace
    .getState()
    .project.faces.find((known) => known.id === faceId);
  const option = session
    .strategyOptions({ available: false, reason: "Choose a run." })
    .find(({ kind }) => kind === "image-model");
  if (!(face && option)) {
    throw new Error("Missing face or strategy");
  }
  const ignore = () => undefined;
  const generate = render(
    <StrategyDetails
      catalogue={{ status: "idle" }}
      face={face}
      onChooseRecorded={ignore}
      onKey={ignore}
      onListRecorded={ignore}
      option={option}
      providerKey=""
      recorded={undefined}
      ruled={0}
      targets={24}
    />
  );
  const family = render(
    <FamilyStrategyDetails
      onKey={ignore}
      option={option}
      providerKey=""
      ruled={0}
      targets={24}
      weights={1}
    />
  );
  expect(
    generate.container.querySelector('[data-testid="estimate"]')?.outerHTML
  ).toBe(family.container.querySelector('[data-testid="estimate"]')?.outerHTML);
  expect(
    generate.container.querySelector("[data-calls]")?.getAttribute("data-calls")
  ).toBe("1");
  expect(generate.container.textContent).toContain(
    "No dollar figure can be given."
  );
});
