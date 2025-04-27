import type { BoxProps } from "ink";

import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme";

// Define allowed border styles, including 'none'
type SectionBorderStyle = BoxProps["borderStyle"] | "none";

interface SectionProps {
  children: React.ReactNode;
  title?: string;
  borderStyle?: SectionBorderStyle;
  width?: BoxProps["width"]; // Use width for size control
  center?: boolean;
  // Allow passing other Box props for the *inner* styled box
  gap?: BoxProps["gap"];
  padding?: BoxProps["padding"];
  // Explicitly define common margin props for the *outer* centering box
  marginY?: BoxProps["marginY"];
  marginX?: BoxProps["marginX"];
  marginTop?: BoxProps["marginTop"];
  marginBottom?: BoxProps["marginBottom"];
  marginLeft?: BoxProps["marginLeft"];
  marginRight?: BoxProps["marginRight"];
}

export function Section({
  children,
  title,
  borderStyle = theme.borders.default,
  width = "100%", // Default to 100% width
  center = false,
  gap = theme.spacing.xs, // Default gap for inner content
  padding = theme.spacing.sm,
  marginY,
  marginX,
  marginTop,
  marginBottom,
  marginLeft,
  marginRight, // Destructure margin props
}: SectionProps) {
  const effectiveBorderStyle = borderStyle === "none" ? undefined : borderStyle;

  const innerSection = (
    <Box
      flexDirection="column"
      borderStyle={effectiveBorderStyle}
      borderColor={theme.colors.border}
      padding={padding}
      width={width} // Apply width to the inner box
      gap={gap} // Apply gap to inner content
    >
      {title && (
        <Box marginBottom={theme.spacing.xs}>
          <Text bold color={theme.colors.secondary}>
            {title}
          </Text>
        </Box>
      )}
      {children}
    </Box>
  );

  // If centering is requested, wrap the inner section in a centering Box
  if (center) {
    return (
      <Box
        justifyContent="center"
        alignItems="center"
        width="100%" // Outer box takes full width to allow centering
        // Apply margin props to the outer centering box
        marginY={marginY}
        marginX={marginX}
        marginTop={marginTop}
        marginBottom={marginBottom}
        marginLeft={marginLeft}
        marginRight={marginRight}
      >
        {innerSection}
      </Box>
    );
  }

  // Otherwise, return the inner section directly, applying margins to it
  return React.cloneElement(innerSection, {
    marginY,
    marginX,
    marginTop,
    marginBottom,
    marginLeft,
    marginRight,
  });
}
