import type { CliRenderer } from "@opentui/core";
import type { ReactNode } from "react";
import { ThemeContext } from "@/hooks/use-theme";
import { amberTheme } from "@/model/theme";
import { renderReactStory } from "./render-react-story";

interface FrameSize {
  readonly height: number;
  readonly padded?: boolean;
  readonly width: number;
}

const THEME = { setTheme: () => undefined, theme: amberTheme };

function Frame({
  children,
  height,
  padded = true,
  width,
}: FrameSize & { readonly children: ReactNode }) {
  return (
    <ThemeContext.Provider value={THEME}>
      <box
        backgroundColor={amberTheme.colors.background}
        flexDirection="column"
        flexShrink={0}
        height={height}
        padding={padded ? 1 : 0}
        width={width}
      >
        {children}
      </box>
    </ThemeContext.Provider>
  );
}

export function renderFrame(
  renderer: CliRenderer,
  content: ReactNode,
  size: FrameSize
) {
  return renderReactStory(renderer, <Frame {...size}>{content}</Frame>);
}

export const ignore = () => undefined;
