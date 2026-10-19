import "./scene-composition-controls.css";
import { type ChangeEvent, type MouseEvent, useCallback, useId } from "react";
import {
  isSceneLayerId,
  isSceneLayerVisible,
  type SceneComposition,
  sceneCompositionPresets,
  sceneLayerDefinitions,
  sceneLayerSolo,
} from "../settings/scene-composition";

const categories = [
  ...new Set(sceneLayerDefinitions.map(({ category }) => category)),
];

/** Temporary isolation preserves the visibility choices to return to afterward. */
export function SceneCompositionControls({
  composition,
  disabled,
  onChange,
}: {
  composition: SceneComposition;
  disabled: boolean;
  onChange: (composition: SceneComposition) => void;
}) {
  const descriptionId = useId();
  const soloing = composition.solo.length > 0;
  const changeVisibility = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { name: id, checked: visible } = event.currentTarget;
      if (!isSceneLayerId(id)) {
        return;
      }
      if (soloing) {
        const solo = visible
          ? [...composition.solo, id]
          : composition.solo.filter((layer) => layer !== id);
        if (solo.length > 0) {
          onChange({ ...composition, solo });
        }
        return;
      }
      onChange({
        ...composition,
        hidden: visible
          ? composition.hidden.filter((layer) => layer !== id)
          : [...composition.hidden, id],
      });
    },
    [composition, onChange, soloing]
  );
  const chooseSolo = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const { value: id } = event.currentTarget;
      if (isSceneLayerId(id)) {
        onChange({ ...composition, solo: sceneLayerSolo(id) });
      }
    },
    [composition, onChange]
  );
  const choosePreset = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const preset = sceneCompositionPresets.find(
        ({ id }) => id === event.currentTarget.value
      );
      if (preset) {
        onChange({ ...composition, solo: [...preset.layers] });
      }
    },
    [composition, onChange]
  );
  const restore = useCallback(
    () => onChange({ ...composition, solo: [] }),
    [composition, onChange]
  );
  const showAll = useCallback(
    () => onChange({ hidden: [], solo: [] }),
    [onChange]
  );
  return (
    <section className="spyglass-scene-visibility">
      <h3>Scene visibility</h3>
      <p>
        Hide or isolate existing layers without rebuilding the map or moving the
        camera. Content still follows its generation and reader settings.
        Soloing an effect includes the ocean. Effects need a visible surface;
        Subsurface drift and Rim surf also follow the Atmosphere controls.
      </p>
      <fieldset aria-describedby={descriptionId} disabled={disabled}>
        <fieldset
          aria-label="Isolate a composition"
          className="spyglass-composition-actions"
        >
          {sceneCompositionPresets.map((preset) => (
            <button
              aria-pressed={
                composition.solo.length === preset.layers.length &&
                preset.layers.every((id) => composition.solo.includes(id))
              }
              key={preset.id}
              onClick={choosePreset}
              type="button"
              value={preset.id}
            >
              {preset.label}
            </button>
          ))}
        </fieldset>
        <div className="spyglass-composition-actions">
          <button disabled={!soloing} onClick={restore} type="button">
            Restore previous view
          </button>
          <button onClick={showAll} type="button">
            Show all
          </button>
        </div>
        <p id={descriptionId} role="status">
          {soloing
            ? "Solo view: check layers to add or remove them. Keep at least one layer, or restore your previous visibility choices."
            : "Checkboxes show or hide layers. Solo and presets temporarily isolate a view; your visibility choices are saved."}
        </p>
        {categories.map((category) => (
          <fieldset className="spyglass-control-group" key={category}>
            <legend>{category}</legend>
            {sceneLayerDefinitions
              .filter((layer) => layer.category === category)
              .map(({ id, label }) => {
                const visible = isSceneLayerVisible(composition, id);
                const soloLayers = sceneLayerSolo(id);
                return (
                  <div className="spyglass-composition-row" key={id}>
                    <label className="spyglass-control spyglass-toggle">
                      <span>{label}</span>
                      <input
                        aria-label={`${soloing ? "Include in solo" : "Show"}: ${label}`}
                        checked={visible}
                        disabled={
                          soloing && visible && composition.solo.length === 1
                        }
                        name={id}
                        onChange={changeVisibility}
                        type="checkbox"
                      />
                    </label>
                    <button
                      aria-label={`Solo ${label}`}
                      aria-pressed={
                        composition.solo.length === soloLayers.length &&
                        soloLayers.every((layer) =>
                          composition.solo.includes(layer)
                        )
                      }
                      onClick={chooseSolo}
                      type="button"
                      value={id}
                    >
                      Solo
                    </button>
                  </div>
                );
              })}
          </fieldset>
        ))}
      </fieldset>
    </section>
  );
}
