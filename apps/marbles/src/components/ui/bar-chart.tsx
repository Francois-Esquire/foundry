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
const MIN_BAR_WIDTH = 5;
const MIN_LABEL_WIDTH = 16;
const MAX_LABEL_WIDTH = 20;
const GAPS = 4;

function Bar({
  value,
  max,
  color,
  width,
}: {
  readonly value: number;
  readonly max: number;
  readonly color: string;
  readonly width: number;
}) {
  const filled = value > 0 ? Math.max(1, Math.round((value / max) * width)) : 0;
  return (
    <text fg={color} flexShrink={0} width={width} wrapMode="none">
      {"█".repeat(filled)}
      <span fg={theme.colors.mutedForeground}>
        {"░".repeat(width - filled)}
      </span>
    </text>
  );
}

function barWidth(
  availableWidth: number,
  valueWidth: number,
  labelWidth: number
): number {
  const room = availableWidth - valueWidth - GAPS;
  const width = Math.min(BAR_WIDTH, Math.max(MIN_BAR_WIDTH, room - labelWidth));
  return room - width >= Math.min(labelWidth, MIN_LABEL_WIDTH) ? width : 0;
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
    MAX_LABEL_WIDTH,
    Math.max(0, ...data.map(({ label }) => label.length))
  );
  const bars =
    data.length > 1 && max > 0 && Number.isFinite(max)
      ? barWidth(availableWidth, width, labelWidth)
      : 0;

  return data.map(({ id, label, value, valueLabel }) => (
    <box flexDirection="row" gap={2} height={1} key={id}>
      <Text flexGrow={1} minWidth={0} truncate wrapMode="none">
        {label}
      </Text>
      {bars > 0 && <Bar color={color} max={max} value={value} width={bars} />}
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
