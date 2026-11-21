import type { CliRenderer } from "@opentui/core";
import type { ReactNode } from "react";
import { defaultTheme } from "@/lib/terminal-themes/default";
import { renderReactStory } from "./render-react-story";

interface FrameSize {
  readonly height: number;
  readonly padded?: boolean;
  readonly width: number;
}

function Frame({
  children,
  height,
  padded = true,
  width,
}: FrameSize & { readonly children: ReactNode }) {
  return (
    <box
      backgroundColor={defaultTheme.colors.background}
      flexDirection="column"
      flexShrink={0}
      height={height}
      padding={padded ? 1 : 0}
      width={width}
    >
      {children}
    </box>
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
