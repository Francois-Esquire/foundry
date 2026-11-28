import type { Slot } from "@/model/context";
import { hud } from "@/model/palette";

export function Toolkit({
  focused,
  selected,
  slots,
}: {
  readonly focused: boolean;
  readonly selected: number;
  readonly slots: readonly Slot[];
}) {
  if (slots.length === 0) {
    return <text fg={hud.dim}>No skills or MCP servers.</text>;
  }
  const chosen = slots[selected];
  return (
    <box flexDirection="column">
      {slots.map((slot, index) => {
        const active = focused && index === selected;
        return (
          <box
            backgroundColor={active ? hud.tint : undefined}
            flexDirection="row"
            flexShrink={0}
            gap={1}
            height={1}
            key={`${slot.kind}-${slot.name}`}
          >
            <text fg={active ? hud.amber : hud.faint}>
              {active ? "▶" : " "}
            </text>
            <text fg={hud.bronze}>{String(index + 1).padStart(2, "0")}</text>
            <text
              fg={active ? hud.bright : hud.text}
              flexShrink={1}
              truncate
              wrapMode="none"
            >
              {slot.name}
            </text>
            <box flexGrow={1} />
            <text fg={hud.dim} flexShrink={0}>
              {slot.kind}
            </text>
          </box>
        );
      })}
      {focused && chosen ? (
        <text fg={hud.dim}>{chosen.description}</text>
      ) : null}
    </box>
  );
}
