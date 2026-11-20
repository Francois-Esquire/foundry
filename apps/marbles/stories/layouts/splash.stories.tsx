import { defineStories, story } from "textbook-sh";
import { SplashLayout } from "~/components/layouts/splash";
import { Dialog } from "~/components/ui/dialog";
import { theme } from "~/components/ui/theme";
import { ignore, renderFrame } from "../frame";

function Card({ width }: { readonly width: number }) {
  return (
    <box
      backgroundColor={theme.colors.background}
      border
      borderColor={theme.colors.accent}
      borderStyle="rounded"
      flexDirection="column"
      paddingX={2}
      width={width}
      zIndex={1}
    >
      <text fg={theme.colors.accent}>
        <strong>card</strong>
      </text>
      <text fg={theme.colors.mutedForeground}>Centred over the field</text>
    </box>
  );
}

function arranged({
  height,
  overlay = false,
  paused = false,
  width,
}: {
  readonly height: number;
  readonly overlay?: boolean;
  readonly paused?: boolean;
  readonly width: number;
}) {
  return (renderer: Parameters<typeof renderFrame>[0]) =>
    renderFrame(
      renderer,
      <SplashLayout
        card={<Card width={Math.min(40, width - 4)} />}
        height={height}
        onResize={ignore}
        overlay={
          overlay && (
            <Dialog onCancel={ignore} onConfirm={ignore} title="overlay">
              <text fg={theme.colors.mutedForeground}>Covers the card</text>
            </Dialog>
          )
        }
        paused={paused}
        width={width}
      />,
      { height, padded: false, width }
    );
}

export default defineStories({
  component: "SplashLayout",
  description:
    "The sparkle field behind a centred card, with an optional overlay.",
  title: "Layouts/Splash",
});

export const Wide = story({
  description: "A 100 by 30 field with the card centred and the field moving.",
  name: "Wide",
  render: arranged({ height: 30, width: 100 }),
});

export const Narrow = story({
  description: "A 50 by 16 field; the card stays centred.",
  name: "Narrow",
  render: arranged({ height: 16, width: 50 }),
});

export const Paused = story({
  description:
    "The field holds still, as it does while the quit dialog is open.",
  name: "Paused",
  render: arranged({ height: 24, paused: true, width: 80 }),
});

export const WithOverlay = story({
  description: "An overlay over the card on a paused field.",
  name: "With overlay",
  render: arranged({ height: 24, overlay: true, paused: true, width: 80 }),
});
