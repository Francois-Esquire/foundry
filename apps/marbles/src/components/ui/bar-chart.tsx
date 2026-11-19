import type { ReactNode } from "react";
import { Text } from "./text";
import { theme } from "./theme";

interface BarChartItem {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly valueLabel: ReactNode;
  readonly valueWidth: number;
}

const BAR_WIDTH = 10;

function Bar({
  value,
  max,
  color,
}: {
  readonly value: number;
  readonly max: number;
  readonly color: string;
}) {
  const filled =
    value > 0 ? Math.max(1, Math.round((value / max) * BAR_WIDTH)) : 0;
  return (
    <text fg={color} flexShrink={0} width={BAR_WIDTH} wrapMode="none">
      {"█".repeat(filled)}
      <span fg={theme.colors.mutedForeground}>
        {"░".repeat(BAR_WIDTH - filled)}
      </span>
    </text>
  );
}

export function BarChart({
  data,
  color,
  availableWidth,
}: {
  readonly data: readonly BarChartItem[];
  readonly color: string;
  readonly availableWidth: number;
}) {
  const max = Math.max(0, ...data.map((item) => item.value));
  const width = Math.max(0, ...data.map((item) => item.valueWidth));
  const labelWidth = Math.min(
    20,
    Math.max(0, ...data.map(({ label }) => label.length))
  );
  const showBars =
    data.length > 1 &&
    max > 0 &&
    Number.isFinite(max) &&
    availableWidth >= width + labelWidth + BAR_WIDTH + 4;

  return data.map(({ id, label, value, valueLabel }) => (
    <box flexDirection="row" gap={2} height={1} key={id}>
      <Text flexGrow={1} minWidth={0} truncate wrapMode="none">
        {label}
      </Text>
      {showBars && <Bar color={color} max={max} value={value} />}
      <box
        flexDirection="row"
        flexShrink={0}
        justifyContent="flex-end"
        width={width}
      >
        {valueLabel}
      </box>
    </box>
  ));
}
