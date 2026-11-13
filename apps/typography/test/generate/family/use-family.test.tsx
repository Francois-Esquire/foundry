/** @vitest-environment happy-dom */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useFamilyPlan } from "~/generate/family/use-family";
import { namedCharacters } from "~/generate/request-draft";
import type { Draft } from "~/generate/session";
import { useClassification } from "~/generate/use-session";
import { WorkspaceProvider } from "~/workspace/react";
import { sofiaSession } from "./helpers/family-session";

afterEach(cleanup);

it.each(["typed", "language", "script"] as const)(
  "gives Family the shared characters for a %s draft",
  async (source) => {
    const { faceId, workspace } = await sofiaSession();
    const face = workspace
      .getState()
      .project.faces.find((known) => known.id === faceId);
    if (!face) {
      throw new Error("Missing face.");
    }
    const draft: Draft = {
      language: "test",
      recordedId: "",
      scope: "script:Latn",
      source,
      strategy: "procedural",
      typed: "ĉĝĉa",
    };
    const languages = [
      {
        auxiliary: new Uint32Array([0x1_69]),
        name: "Test",
        required: new Uint32Array([0x1_09, 0x1_1d]),
        script: "Latn",
        tag: "test",
      },
    ];
    const { result } = renderHook(
      () => {
        const { classify } = useClassification(face);
        return {
          family: useFamilyPlan(face, draft, languages),
          named: namedCharacters(draft, classify, languages),
        };
      },
      {
        wrapper: ({ children }) => (
          <WorkspaceProvider workspace={workspace}>
            {children}
          </WorkspaceProvider>
        ),
      }
    );
    expect(result.current.family.characters).toEqual(result.current.named);
    expect(result.current.named.length).toBeGreaterThan(0);
  }
);
