import "./scene-composition-controls.css";
import { useCallback } from "react";
import type {
  FoundationMember,
  SpyglassFoundation,
  SpyglassFrame,
} from "../data/types";
import { foundationOverviewLimit } from "../layout/foundation-field";
import { isSceneLayerVisible } from "../settings/scene-composition";
import type { ChromeContext } from "./chrome-entries";
import {
  SettingsRange,
  SettingsSelect,
  SettingsToggle,
} from "./settings-controls";

const coverageDescriptions = {
  complete: "Dependency graph resolved from the saved scan.",
  partial:
    "Partial dependency graph: some targets or versions could not be resolved. Plateaus show the known relationships.",
  unavailable:
    "Dependency graph unavailable. Declared relationships may be shown, but transitive coverage is incomplete. Rescan with a supported Bun lockfile to resolve it.",
};

function foundationTitle(
  foundation: SpyglassFoundation,
  frames: readonly SpyglassFrame[]
): string {
  if (frames.length < 2) {
    return foundation.name;
  }
  const [member] = foundation.members;
  const owner =
    member &&
    frames.find((frame) => frame.territories.includes(member.territoryId));
  const context = owner?.label || owner?.id || foundation.id;
  return `${foundation.name} · ${context}`;
}

function Usage({ member }: { member: FoundationMember }) {
  const { usage } = member;
  if (!usage) {
    return (
      <span> · Import usage {member.direct ? "not measured" : "indirect"}</span>
    );
  }
  return (
    <span>
      {" "}
      · {usage.importingFiles.length} importing files (
      {usage.runtimeFiles.length} runtime, {usage.typeOnlyFiles.length}{" "}
      type-only)
    </span>
  );
}

export function FoundationControls({
  actions,
  state,
}: {
  actions: Pick<ChromeContext["actions"], "settings" | "sceneReady">;
  state: Pick<ChromeContext["state"], "data" | "chartSettings">;
}) {
  const settings = state.chartSettings;
  const { composition } = settings;
  const foundations = state.data.foundations ?? [];
  const selected = foundations.find(
    ({ id }) => id === settings.foundationFocus
  );
  const disabled = !actions.sceneReady || foundations.length === 0;
  const changeFocus = useCallback(
    (_name: string, value: string) => {
      actions.settings({ ...settings, foundationFocus: value });
    },
    [actions.settings, settings]
  );
  const changeInfluence = useCallback(
    (_name: string, value: number) => {
      actions.settings({ ...settings, foundationInfluence: value });
    },
    [actions.settings, settings]
  );
  const changeVisibility = useCallback(
    (_name: string, visible: boolean) => {
      const id = "dependency-foundations";
      if (composition.solo.length > 0) {
        const solo = visible
          ? ([...composition.solo, id] as const)
          : composition.solo.filter((layer) => layer !== id);
        actions.settings({
          ...settings,
          composition: { ...composition, solo: solo.length ? solo : ["sea"] },
        });
        return;
      }
      actions.settings({
        ...settings,
        composition: {
          ...composition,
          hidden: visible
            ? composition.hidden.filter((layer) => layer !== id)
            : [...composition.hidden, id],
        },
      });
    },
    [actions.settings, composition, settings]
  );
  const isolate = useCallback(() => {
    actions.settings({
      ...settings,
      composition: {
        ...composition,
        solo: ["sea", "dependency-foundations", "subsurface-drift"],
      },
    });
  }, [actions.settings, composition, settings]);
  const restore = useCallback(() => {
    actions.settings({
      ...settings,
      composition: { ...composition, solo: [] },
    });
  }, [actions.settings, composition, settings]);
  const coverage = state.data.dependencyCoverage;
  return (
    <section
      aria-label="Dependency foundations"
      className="spyglass-chart-settings"
    >
      <p>
        Underwater plateaus connect islands that share runtime or optional
        dependencies. Indirect reliance contributes less strongly.
      </p>
      <p role="status">{coverageDescriptions[coverage ?? "unavailable"]}</p>
      {foundations.length === 0 && (
        <p>No shared dependency foundations are available for these islands.</p>
      )}
      <SettingsSelect
        disabled={disabled}
        label="Show foundation"
        name="foundationFocus"
        onChange={changeFocus}
        options={[
          {
            label: `Overview · strongest ${Math.min(foundations.length, foundationOverviewLimit)} of ${foundations.length}`,
            value: "",
          },
          ...[...foundations]
            .sort(
              (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
            )
            .map((foundation) => ({
              label: `${foundationTitle(foundation, state.data.frames)} · ${foundation.members.length} islands`,
              value: foundation.id,
            })),
        ]}
        value={settings.foundationFocus}
      />
      <SettingsToggle
        checked={isSceneLayerVisible(composition, "dependency-foundations")}
        disabled={disabled}
        label="Show plateaus"
        name="dependency-foundations"
        onChange={changeVisibility}
      />
      <div className="spyglass-composition-actions">
        <button disabled={disabled} onClick={isolate} type="button">
          Isolate foundations
        </button>
        <button
          disabled={!actions.sceneReady || composition.solo.length === 0}
          onClick={restore}
          type="button"
        >
          Restore layers
        </button>
      </div>
      <p>
        Showing, hiding, or selecting a plateau keeps island positions fixed.
        Moving foundation light is decorative.
      </p>
      <SettingsRange
        commitOnRelease
        disabled={disabled}
        label="Foundation layout influence"
        max={1}
        min={0}
        name="foundationInfluence"
        onChange={changeInfluence}
        step={0.05}
        value={settings.foundationInfluence}
      />
      <p>
        Influence changes island placement. Zero keeps the original package
        layout.
      </p>
      {selected && (
        <section aria-label="Selected foundation">
          <h3>{foundationTitle(selected, state.data.frames)}</h3>
          <p>
            {selected.versions.length
              ? `Resolved versions: ${selected.versions.join(", ")}`
              : "Resolved version unknown."}
          </p>
          <ul>
            {selected.members.map((member) => (
              <li key={member.territoryId}>
                <strong>
                  {state.data.territories.find(
                    ({ id }) => id === member.territoryId
                  )?.label ?? member.territoryId}
                </strong>
                {member.direct
                  ? " · Direct dependency"
                  : ` · Transitive, ${member.distance} steps`}
                <Usage member={member} />
              </li>
            ))}
          </ul>
          <p>
            Usage counts are observed static imports. A declaration with no
            observed imports remains a dependency.
          </p>
        </section>
      )}
    </section>
  );
}
