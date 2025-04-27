import React, { useMemo } from "react";
import gradientString from "gradient-string";
import { Transform } from "ink";
import stripAnsi from "strip-ansi";

interface Props {
  name?: string;
  colors?: string[];
  children: React.ReactNode;
}

export function Gradient({ name, colors, children }: Props) {
  return (
    <Transform
      transform={useMemo(() => {
        if (name && colors) {
          throw new Error(
            "The `name` and `colors` props are mutually exclusive",
          );
        }

        let gradient;
        if (name) {
          // @ts-expect-error deprecated usage style but still works
          gradient = gradientString[name];
        } else if (colors) {
          gradient = gradientString(colors);
        } else {
          throw new Error("Either `name` or `colors` prop must be provided");
        }

        const applyGradient = (text: string) =>
          gradient.multiline(stripAnsi(text));

        return applyGradient;
      }, [name, colors])}
    >
      {children}
    </Transform>
  );
}
