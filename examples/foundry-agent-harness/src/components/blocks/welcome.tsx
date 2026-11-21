import { Hint } from "@/components/blocks/hint";
import { useTheme } from "@/hooks/use-theme";

const EXAMPLE_GOALS = [
  "Read package.json here and explain how to run this example.",
  "List the source files here and say what each one is for.",
];

export function Welcome() {
  const theme = useTheme();
  return (
    <box flexDirection="column" gap={1}>
      <text>Give the harness a goal. It will:</text>
      <box flexDirection="column">
        <text> 1. plan the goal into a short to-do list</text>
        <text> 2. work through each to-do with Claude Code</text>
        <text> 3. keep the results as one artifact version</text>
      </box>
      <Hint>Try one of these:</Hint>
      <box flexDirection="column">
        {EXAMPLE_GOALS.map((goal) => (
          <text fg={theme.colors.accent} key={goal}>{`  ${goal}`}</text>
        ))}
      </box>
    </box>
  );
}
