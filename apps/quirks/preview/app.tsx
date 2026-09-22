import type { KeyEvent } from "@opentui/core";
import { useCallback, useEffect, useState } from "react";
import { Text } from "~/components/ui/text";
import { Action } from "../src/components/action";
import { DashboardView } from "../src/views/dashboard";
import type { JsonValue, RunSnapshot } from "../src/views/dashboard-model";
import { previewScenarios } from "./scenarios";

type PreviewAction = "previous" | "next" | "play" | "advance" | "reset";
const PLAYBACK_INTERVAL = 1200;

export function PreviewApp({ onClose }: { readonly onClose: () => void }) {
  const [manualRuns, setManualRuns] = useState<readonly RunSnapshot[]>([]);
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const [frameIndex, setFrameIndex] = useState(2);
  const [playing, setPlaying] = useState(false);
  const scenario = previewScenarios[scenarioIndex];
  const frameCount = scenario?.frames.length ?? 0;
  useEffect(() => {
    if (!playing) {
      return;
    }
    const timer = setInterval(
      () => setFrameIndex((index) => Math.min(frameCount - 1, index + 1)),
      PLAYBACK_INTERVAL
    );
    return () => clearInterval(timer);
  }, [playing, frameCount]);
  useEffect(() => {
    if (frameIndex >= frameCount - 1) {
      setPlaying(false);
    }
  }, [frameIndex, frameCount]);
  const action = useCallback(
    (command: PreviewAction) => {
      switch (command) {
        case "previous":
        case "next":
          setScenarioIndex(
            (index) =>
              (index + (command === "next" ? 1 : previewScenarios.length - 1)) %
              previewScenarios.length
          );
          setManualRuns([]);
          setFrameIndex(0);
          setPlaying(false);
          break;
        case "reset":
          setFrameIndex(0);
          setPlaying(false);
          break;
        case "advance":
          setFrameIndex((index) => Math.min(frameCount - 1, index + 1));
          setPlaying(false);
          break;
        case "play":
          if (frameCount < 2) {
            return;
          }
          if (frameIndex === frameCount - 1) {
            setFrameIndex(0);
          }
          setPlaying((value) => !value);
          break;
        default:
          break;
      }
    },
    [frameCount, frameIndex]
  );
  const shortcut = useCallback(
    (key: KeyEvent) => {
      const commands: Record<string, PreviewAction> = {
        "[": "previous",
        "]": "next",
        n: "advance",
        p: "play",
        r: "reset",
      };
      const command = commands[key.sequence];
      if (command) {
        action(command);
      }
    },
    [action]
  );
  const snapshot = scenario?.frames[Math.min(frameIndex, frameCount - 1)];
  const launch = useCallback(
    (name: string, input: unknown): Promise<string> => {
      if (scenario?.id === "launch-error") {
        return Promise.reject(
          new Error("Preview: executor unavailable. Your inputs are preserved.")
        );
      }
      const id = `preview-${Date.now()}`;
      const run: RunSnapshot = {
        definitionId: name,
        elapsed: "0.1s",
        id,
        input: input as JsonValue,
        name,
        result: { preview: true },
        started: "Just now",
        status: "complete",
        steps: [],
      };
      setManualRuns((previous) => [run, ...previous]);
      return Promise.resolve(id);
    },
    [scenario?.id]
  );
  if (!(scenario && snapshot)) {
    return <Text>No preview scenario available.</Text>;
  }
  const toolbar = (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" flexWrap="wrap" gap={2}>
        <Text>
          Scenario {scenarioIndex + 1}/{previewScenarios.length}:{" "}
          {scenario.label}
        </Text>
        <Action label="[ previous" onAction={action} value="previous" />
        <Action label="] next" onAction={action} value="next" />
      </box>
      <box flexDirection="row" flexWrap="wrap" gap={2}>
        <Text>
          Frame {frameIndex + 1}/{frameCount}
        </Text>
        {frameCount > 1 && (
          <Action
            label={playing ? "p Pause" : "p Play"}
            onAction={action}
            value="play"
          />
        )}
        {frameCount > 1 && (
          <Action label="n Advance" onAction={action} value="advance" />
        )}
        <Action label="r Reset" onAction={action} value="reset" />
      </box>
    </box>
  );
  return (
    <DashboardView
      key={scenario.id}
      onClose={onClose}
      onLaunch={launch}
      onShortcut={shortcut}
      snapshot={{ ...snapshot, runs: [...manualRuns, ...snapshot.runs] }}
      toolbar={toolbar}
      viewportWidth={scenario.width}
    />
  );
}
