import React from "react";
import { Box, Text } from "ink";

interface IgnotProps {
  color?: string;
  size?: "small" | "medium" | "large";
}

/**
 * ASCII Art Ignot (metal ingot) component
 */
export function Ignot({ color = "yellow", size = "medium" }: IgnotProps) {
  // Different sizes of ignot
  const artSmall = `
    ╔════╗
    ║    ║
    ╚════╝
  `;

  const artMedium = `
    ╔═════════╗
    ║         ║
    ║         ║
    ║         ║
    ╚═════════╝
  `;

  const artLarge = `
   ╔════════════════════╗
   ║                    ║
   ║                    ║
   ║                    ║
   ║                    ║
   ║                    ║
   ║                    ║
   ╚════════════════════╝
  `;

  let artToShow;
  switch (size) {
    case "small":
      artToShow = artSmall;
      break;
    case "large":
      artToShow = artLarge;
      break;
    case "medium":
    default:
      artToShow = artMedium;
  }

  return (
    <Box flexDirection="column" alignItems="center">
      <Text color={color} dimColor={color === "yellow"}>
        {artToShow}
      </Text>
    </Box>
  );
}

/**
 * A fancier three-dimensional-looking ignot
 */
export function Ignot3D({ color = "yellow" }: Omit<IgnotProps, "size">) {
  const art = `
     ╔═══════════════╗
    ╔╝               ╚╗
   ║                   ║
   ║                   ║
   ║                   ║
   ║                   ║
   ╚╗                 ╔╝
    ╚═══════════════════╝
  `;

  return (
    <Box flexDirection="column" alignItems="center">
      <Text color={color}>{art}</Text>
    </Box>
  );
}

/**
 * A shiny gold ignot with shading
 */
export function GoldIgnot() {
  return (
    <Box flexDirection="column" alignItems="center">
      <Text>
        <Text color="yellow"> ╔═════════════╗</Text>
      </Text>
      <Text>
        <Text color="yellow"> ╔╝</Text>
        <Text color="yellow" bold>
          {" "}
        </Text>
        <Text color="yellow">╚╗</Text>
      </Text>
      <Text>
        <Text color="yellow">║</Text>
        <Text color="yellow" bold>
          {" "}
        </Text>
        <Text color="yellow">║</Text>
      </Text>
      <Text>
        <Text color="yellow">║</Text>
        <Text color="yellow" bold>
          {" "}
          GOLD BAR{" "}
        </Text>
        <Text color="yellow">║</Text>
      </Text>
      <Text>
        <Text color="yellow">║</Text>
        <Text color="yellow" bold>
          {" "}
        </Text>
        <Text color="yellow">║</Text>
      </Text>
      <Text>
        <Text color="yellow">╚╗</Text>
        <Text color="yellow" bold>
          {" "}
        </Text>
        <Text color="yellow">╔╝</Text>
      </Text>
      <Text>
        <Text color="yellow"> ╚═════════════╝</Text>
      </Text>
    </Box>
  );
}

/**
 * A silver ignot with shine effect
 */
export function SilverIgnot() {
  return (
    <Box flexDirection="column" alignItems="center">
      <Text>
        <Text color="gray"> ╔═════════════╗</Text>
      </Text>
      <Text>
        <Text color="gray"> ╔╝</Text>
        <Text color="white"> </Text>
        <Text color="gray">╚╗</Text>
      </Text>
      <Text>
        <Text color="gray">║</Text>
        <Text color="white"> </Text>
        <Text color="gray" dimColor>
          {" "}
        </Text>
        <Text color="white"> </Text>
        <Text color="gray">║</Text>
      </Text>
      <Text>
        <Text color="gray">║</Text>
        <Text color="white" bold>
          {" "}
          SILVER BAR{" "}
        </Text>
        <Text color="gray">║</Text>
      </Text>
      <Text>
        <Text color="gray">║</Text>
        <Text color="white"> </Text>
        <Text color="gray" dimColor>
          {" "}
        </Text>
        <Text color="white"> </Text>
        <Text color="gray">║</Text>
      </Text>
      <Text>
        <Text color="gray">╚╗</Text>
        <Text color="white"> </Text>
        <Text color="gray">╔╝</Text>
      </Text>
      <Text>
        <Text color="gray"> ╚═════════════╝</Text>
      </Text>
    </Box>
  );
}
