import { halfBlocks, type PortraitMoment, portrait } from "@/model/portrait";

export function Portrait(moment: PortraitMoment) {
  return (
    <box flexDirection="column" flexShrink={0}>
      {halfBlocks(portrait(moment)).map((line, row) => (
        <text key={`row-${row}`} wrapMode="none">
          {line.map((run, index) => (
            <span bg={run.bottom} fg={run.top} key={`run-${index}`}>
              {"▀".repeat(run.cells)}
            </span>
          ))}
        </text>
      ))}
    </box>
  );
}
