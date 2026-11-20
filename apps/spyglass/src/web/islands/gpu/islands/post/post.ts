import {
  type Effect,
  effect,
  type Frame,
  type Gpu,
  type ShaderSource,
  type Target,
  target,
} from "vgpu";

export interface PostShaders {
  postAntialias: ShaderSource;
  postBloom: ShaderSource;
  postFinish: ShaderSource;
}

export interface PostLook {
  readonly antialias: boolean;
  readonly bloom: number;
  readonly bloomRadius: number;
  readonly bloomThreshold: number;
  readonly vignette: number;
  readonly vignetteColor: readonly number[];
}

const LEVELS = 5;
const KNEE = 0.5;
const FRAME_FORMAT = "rgba16float";

const weightFor = (radius: number) =>
  Math.min(Math.max(0.45 + 0.3 * radius, 0.3), 1.1);

function bloomGain(radius: number): number {
  const weight = weightFor(radius);
  let gain = 1;
  for (let i = 1; i < LEVELS; i += 1) {
    gain += weight ** i;
  }
  return gain;
}

export interface Post {
  compile: (output: Target) => Promise<void>;
  dispose: () => void;
  readonly frame: Target;
  render: (encoder: Frame, output: Target, look: PostLook) => void;
  resize: (size: readonly [number, number]) => void;
}

export function createPost(
  gpu: Gpu,
  shaders: PostShaders,
  linear: GPUSampler
): Post {
  const frame = target(gpu, {
    format: FRAME_FORMAT,
    label: "islands-frame",
    size: [1, 1],
  });
  const finished = target(gpu, {
    format: "rgba8unorm",
    label: "islands-finished",
    size: [1, 1],
  });
  const levels: Target[] = Array.from({ length: LEVELS }, (_, i) =>
    target(gpu, {
      format: FRAME_FORMAT,
      label: `islands-bloom-${i}`,
      size: [1, 1],
    })
  );
  const bloomPass = (entry: string, source: Target, label: string): Effect =>
    effect(gpu, shaders.postBloom, {
      blend: entry === "fs_up" ? "additive" : undefined,
      entry: { fragment: entry },
      label,
      set: { source, sourceSampler: linear },
    });
  const [top] = levels;
  if (!top) {
    throw new Error("The bloom needs at least one level.");
  }
  const steps = levels.slice(1).map((smaller, i) => ({
    larger: levels[i] ?? top,
    smaller,
  }));
  const bright = bloomPass("fs_bright", frame, "islands-bloom-bright");
  const downs = steps.map(({ larger, smaller }, i) => ({
    larger,
    pass: bloomPass("fs_down", larger, `islands-bloom-down-${i}`),
    smaller,
  }));
  const ups = steps.map(({ larger, smaller }, i) => ({
    larger,
    pass: bloomPass("fs_up", smaller, `islands-bloom-up-${i}`),
    smaller,
  }));
  const finish = effect(gpu, shaders.postFinish, {
    label: "islands-finish",
    set: { glow: top, linear, scene: frame },
  });
  const antialias = effect(gpu, shaders.postAntialias, {
    label: "islands-antialias",
    set: { finished, linear },
  });
  const texelOf = (t: Target) => [1 / t.size[0], 1 / t.size[1]] as const;

  return {
    async compile(output) {
      await Promise.all([
        bright.compile(top),
        ...downs.map(({ pass, smaller }) => pass.compile(smaller)),
        ...ups.map(({ larger, pass }) => pass.compile(larger)),
        finish.compile(finished),
        antialias.compile(output),
      ]);
    },
    dispose() {
      const passes = [...downs, ...ups].map(({ pass }) => pass);
      for (const item of [bright, ...passes, finish, antialias]) {
        item.dispose();
      }
    },
    frame,
    render(encoder, output, look) {
      const glowing = look.bloom > 0;
      if (glowing) {
        const weight = weightFor(look.bloomRadius);
        const threshold = look.bloomThreshold;
        const knee = Math.max(threshold * KNEE, 0.02);
        const uniform = (level: Target, w: number) => ({
          bloom: {
            knee,
            radius: look.bloomRadius,
            texel: texelOf(level),
            threshold,
            weight: w,
          },
        });
        bright.set(uniform(frame, 1));
        encoder.pass({ clear: [0, 0, 0, 0], target: top }, (p) =>
          p.draw(bright)
        );
        for (const { larger, pass, smaller } of downs) {
          pass.set(uniform(larger, 1));
          encoder.pass({ clear: [0, 0, 0, 0], target: smaller }, (p) =>
            p.draw(pass)
          );
        }
        for (let i = ups.length - 1; i >= 0; i -= 1) {
          const up = ups[i];
          if (!up) {
            continue;
          }
          up.pass.set(uniform(up.smaller, weight));
          encoder.pass({ clear: false, target: up.larger }, (p) =>
            p.draw(up.pass)
          );
        }
      }
      finish.set({
        finish: {
          bloom: glowing ? look.bloom / bloomGain(look.bloomRadius) : 0,
          vignette: look.vignette,
          vignetteColor: look.vignetteColor,
        },
      });
      encoder.pass({ target: finished }, finish);
      antialias.set({ antialias: { enabled: look.antialias ? 1 : 0 } });
      encoder.pass({ target: output }, antialias);
    },
    resize(size) {
      if (size[0] === frame.size[0] && size[1] === frame.size[1]) {
        return;
      }
      frame.resize(size);
      finished.resize(size);
      for (const [i, level] of levels.entries()) {
        const scale = 2 ** (i + 1);
        level.resize([
          Math.max(1, Math.ceil(size[0] / scale)),
          Math.max(1, Math.ceil(size[1] / scale)),
        ]);
      }
    },
  };
}
