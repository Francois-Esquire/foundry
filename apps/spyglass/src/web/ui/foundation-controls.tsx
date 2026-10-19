import "./scene-composition-controls.css";
import { type MouseEvent, useCallback } from "react";
import { maximumFoundationInfluence } from "../../lib/visualization/types";
import type {
  FoundationMember,
  SpyglassData,
  SpyglassFoundation,
  SpyglassFrame,
} from "../data/types";
import { isSceneLayerVisible } from "../settings/scene-composition";
import {
  isTerrainInspection,
  terrainInspections,
} from "../settings/terrain-inspection";
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

function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function groupTitle(
  group: NonNullable<SpyglassData["foundationGroups"]>[number],
  data: SpyglassData
): string {
  const names = group.memberIds
    .map(
      (id) =>
        data.territories.find((territory) => territory.id === id)?.label ?? id
    )
    .sort((a, b) => a.localeCompare(b));
  const remainder = names.length > 3 ? ` +${names.length - 3} more` : "";
  const label = `Group: ${names.slice(0, 3).join(", ")}${remainder}`;
  if (data.frames.length < 2) {
    return label;
  }
  const [memberId] = group.memberIds;
  const owner = data.frames.find(
    (frame) => memberId !== undefined && frame.territories.includes(memberId)
  );
  return `${label} · ${owner?.label || owner?.id || group.id}`;
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
  const groups = state.data.foundationGroups ?? [];
  const selectedGroup = groups.find(
    ({ id }) => id === settings.foundationFocus
  );
  const selected = foundations.find(
    ({ id }) => id === settings.foundationFocus
  );
  const internal = state.data.internalFoundations ?? [];
  const selectedInternal = internal.find(
    ({ id }) => id === settings.foundationFocus
  );
  const labelOf = (id: string) =>
    state.data.territories.find((territory) => territory.id === id)?.label ??
    id;
  const disabled =
    !actions.sceneReady || foundations.length + internal.length === 0;
  const changeInspection = useCallback(
    (_name: string, value: string) => {
      if (isTerrainInspection(value)) {
        actions.settings({ ...settings, terrainInspection: value });
      }
    },
    [actions.settings, settings]
  );
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
  const choosePull = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      changeInfluence("foundationInfluence", Number(event.currentTarget.value));
    },
    [changeInfluence]
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
      <SettingsRange
        commitOnRelease
        disabled={disabled}
        label="Shared-dependency pull"
        max={maximumFoundationInfluence}
        min={0}
        name="foundationInfluence"
        onChange={changeInfluence}
        step={0.25}
        unit="×"
        value={settings.foundationInfluence}
      />
      <fieldset
        aria-label="Pull strength presets"
        className="spyglass-composition-actions"
      >
        {[
          { label: "Off", value: 0 },
          { label: "Standard · 1×", value: 1 },
          { label: "Strong · 3×", value: 3 },
        ].map(({ label, value }) => (
          <button
            aria-pressed={settings.foundationInfluence === value}
            disabled={disabled}
            key={value}
            onClick={choosePull}
            type="button"
            value={value}
          >
            {label}
          </button>
        ))}
      </fieldset>
      <p>
        More shared dependencies pull islands closer. 0× turns the pull off; 1×
        is the standard strength; up to 4× makes the attraction stronger.
        Release the slider to rearrange the islands. Coast clearance remains
        protected.
      </p>
      <p>
        Shelves rise under islands that share runtime or optional third-party
        dependencies; more shared dependencies raise them nearer the surface.
        Dependencies shared by the same islands form one group. Internal
        foundations are a separate, deeper basement under a workspace package
        and the packages relying on it. Both stop short of unrelated islands,
        and neither reaches the surface. Indirect reliance contributes less
        strongly.
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
            label: `All shared groups · ${countLabel(groups.length, "group")} / ${countLabel(foundations.length, "dependency", "dependencies")}`,
            value: "",
          },
          ...[...groups]
            .sort(
              (a, b) =>
                b.memberIds.length - a.memberIds.length ||
                b.dependencyIds.length - a.dependencyIds.length ||
                a.id.localeCompare(b.id)
            )
            .map((group) => ({
              label: `${groupTitle(group, state.data)} · ${countLabel(group.dependencyIds.length, "dependency", "dependencies")}`,
              value: group.id,
            })),
          ...[...internal]
            .sort(
              (a, b) => b.prominence - a.prominence || a.id.localeCompare(b.id)
            )
            .map((foundation) => ({
              label: `Internal: ${labelOf(foundation.supplierId)} · relied on by ${countLabel(foundation.prominence, "island")}`,
              value: foundation.id,
            })),
          ...[...foundations]
            .sort(
              (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
            )
            .map((foundation) => ({
              label: `Dependency: ${foundationTitle(foundation, state.data.frames)} · ${countLabel(foundation.members.length, "island")}`,
              value: foundation.id,
            })),
        ]}
        value={settings.foundationFocus}
      />
      <SettingsSelect
        disabled={!actions.sceneReady}
        label="Inspect terrain field"
        name="terrainInspection"
        onChange={changeInspection}
        options={terrainInspections.map(({ id, label }) => ({
          label,
          value: id,
        }))}
        value={settings.terrainInspection}
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
      {selectedGroup && (
        <section aria-label="Selected foundation group">
          <h3>{groupTitle(selectedGroup, state.data)}</h3>
          <p>
            These islands share{" "}
            {countLabel(
              selectedGroup.dependencyIds.length,
              "dependency",
              "dependencies"
            )}
            .
          </p>
          <ul aria-label="Group islands">
            {selectedGroup.memberIds.map((id) => (
              <li key={id}>
                {state.data.territories.find((territory) => territory.id === id)
                  ?.label ?? id}
              </li>
            ))}
          </ul>
          <details>
            <summary>
              {countLabel(
                selectedGroup.dependencyIds.length,
                "shared dependency",
                "shared dependencies"
              )}
            </summary>
            <ul aria-label="Group dependencies">
              {selectedGroup.dependencyIds.map((id) => (
                <li key={id}>
                  {foundations.find((foundation) => foundation.id === id)
                    ?.name ?? id}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
      {selectedInternal && (
        <section aria-label="Selected internal foundation">
          <h3>{labelOf(selectedInternal.supplierId)}</h3>
          <p>
            {countLabel(selectedInternal.prominence, "island")} rely on this
            package through runtime dependencies.
          </p>
          <ul aria-label="Dependent islands">
            {selectedInternal.members.map((member) => (
              <li key={member.territoryId}>
                <strong>{labelOf(member.territoryId)}</strong>
                {member.direct
                  ? " · Direct dependency"
                  : ` · Indirect, ${member.distance} steps`}
              </li>
            ))}
          </ul>
        </section>
      )}
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
