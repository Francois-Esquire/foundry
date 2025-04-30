import { Box, Text } from "ink";

export function ChatMetrics({
  tokens = 0,
  cost = 0,
  time = 0,
  context = 0,
}: {
  tokens: number;
  cost: number;
  time: number;
  context: number;
}) {
  return (
    <Text dimColor>
      <Text>Tokens: {tokens}</Text>
      <Text> | </Text>
      <Text>Cost: {cost}</Text>
      <Text> | </Text>
      <Text>Time: {time}</Text>
      <Text> | </Text>
      <Text>Context: {context}</Text>
    </Text>
  );
}
