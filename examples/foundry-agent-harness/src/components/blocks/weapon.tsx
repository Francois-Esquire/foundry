import type { ReactNode } from "react";
import { EFFORTS, type Effort } from "@/model/context";
import { hud } from "@/model/palette";

function Row({
  children,
  focused,
}: {
  readonly children: ReactNode;
  readonly focused: boolean;
}) {
  return (
    <box
      backgroundColor={focused ? hud.tint : undefined}
      flexDirection="row"
      gap={1}
      height={1}
    >
      <text fg={focused ? hud.amber : hud.faint}>{focused ? "▶" : " "}</text>
      {children}
    </box>
  );
}

export function Weapon({
  effort,
  focus,
  locked = false,
  model,
  models,
}: {
  readonly effort: Effort;
  readonly focus: "effort" | "model" | null;
  readonly locked?: boolean;
  readonly model: string;
  readonly models: readonly string[];
}) {
  const rounds = EFFORTS.indexOf(effort) + 1;
  return (
    <box flexDirection="column">
      <Row focused={focus === "model"}>
        <text fg={hud.bronze}>GUN </text>
        <text fg={hud.bright}>
          <b>{model.toUpperCase()}</b>
        </text>
        <box flexGrow={1} />
        <text fg={focus === "model" ? hud.amber : hud.dim} wrapMode="none">
          {locked
            ? "locked"
            : `◂ ${models.indexOf(model) + 1}/${models.length} ▸`}
        </text>
      </Row>
      <Row focused={focus === "effort"}>
        <text fg={hud.bronze}>AMMO</text>
        <text wrapMode="none">
          <span fg={hud.amber}>{"▮".repeat(rounds)}</span>
          <span fg={hud.trough}>{"▯".repeat(EFFORTS.length - rounds)}</span>
        </text>
        <box flexGrow={1} />
        <text fg={focus === "effort" ? hud.amber : hud.dim} wrapMode="none">
          {`${effort} effort`}
        </text>
      </Row>
    </box>
  );
}
