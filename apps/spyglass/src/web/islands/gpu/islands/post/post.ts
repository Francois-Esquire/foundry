/**
 * The post: what the frame gets after the water, kept apart from it. The
 * water composites into `frame`, a linear `rgba16float` target at the
 * output's size; then
 *
 *   1. bloom (shaders/post/bloom.wgsl): a bright-pass to half size, four
 *      downsamples to a thirty-second, and tent upsamples back up, each
 *      added into the level above;
 *   2. finish (shaders/post/finish.wgsl): the bloom added, the vignette, a
 *      shoulder over what the bloom pushes past white, and the sRGB
 *      encoding, into an `rgba8unorm` target;
 *   3. anti-aliasing (shaders/post/antialias.wgsl): FXAA from that onto
 *      the output, or a copy.
 *
 * Everything that can be is baked upstream (the occlusion is the light
 * map's); the post is a handful of fullscreen passes, most at a fraction of
 * the frame. It is not timed per pass: on Metal a pass's timestamps take in
 * the wait for the passes before it, so they read many times the frame. The
 * bench's "no post" case measures it by difference instead.
 */
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

/** What the post reads of the look each frame. */
export interface PostLook {
	readonly antialias: boolean;
	/** The bloom's strength (0 skips the chain), threshold and radius. */
	readonly bloom: number;
	readonly bloomRadius: number;
	readonly bloomThreshold: number;
	readonly vignette: number;
	readonly vignetteColor: readonly number[];
}

/** Levels below the frame: half down to a thirty-second. */
const LEVELS = 5;
/** The bright-pass's knee, as a share of its threshold. */
const KNEE = 0.5;
const FRAME_FORMAT = "rgba16float";

/** The upsample weight for a radius: a wider bloom leans on the deeper levels. */
const weightFor = (radius: number) =>
	Math.min(Math.max(0.45 + 0.3 * radius, 0.3), 1.1);

/** What the chain adds up to at a radius; the strength is divided by it, so it means the same at any radius. */
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
	/** The linear frame the water composites into, at the output's size. */
	readonly frame: Target;
	/** Runs the post from `frame` onto `output`; encodes into `encoder`. */
	render: (encoder: Frame, output: Target, look: PostLook) => void;
	/** Follows the output: the frame at its size, each level half the one above. */
	resize: (size: readonly [number, number]) => void;
}

export function createPost(
	gpu: Gpu,
	shaders: PostShaders,
	linear: GPUSampler
): Post {
	const frame = target(gpu, {
		size: [1, 1],
		format: FRAME_FORMAT,
		label: "islands-frame",
	});
	const finished = target(gpu, {
		size: [1, 1],
		format: "rgba8unorm",
		label: "islands-finished",
	});
	const levels: Target[] = Array.from({ length: LEVELS }, (_, i) =>
		target(gpu, {
			size: [1, 1],
			format: FRAME_FORMAT,
			label: `islands-bloom-${i}`,
		})
	);
	const bloomPass = (entry: string, source: Target, label: string): Effect =>
		effect(gpu, shaders.postBloom, {
			label,
			entry: { fragment: entry },
			blend: entry === "fs_up" ? "additive" : undefined,
			set: { source, sourceSampler: linear },
		});
	const [top] = levels;
	if (!top) {
		throw new Error("The bloom needs at least one level.");
	}
	// Each step joins a level to the next, smaller one: the down pass reads
	// the larger and draws into the smaller, the up pass the other way.
	const steps = levels.slice(1).map((smaller, i) => ({
		// The step before this one ends on the larger level, so it is always there.
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
		set: { scene: frame, glow: top, linear },
	});
	const antialias = effect(gpu, shaders.postAntialias, {
		label: "islands-antialias",
		set: { finished, linear },
	});
	const texelOf = (t: Target) => [1 / t.size[0], 1 / t.size[1]] as const;

	return {
		frame,
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
		render(encoder, output, look) {
			const glowing = look.bloom > 0;
			if (glowing) {
				const weight = weightFor(look.bloomRadius);
				const threshold = look.bloomThreshold;
				const knee = Math.max(threshold * KNEE, 0.02);
				const uniform = (level: Target, w: number) => ({
					bloom: {
						texel: texelOf(level),
						threshold,
						knee,
						radius: look.bloomRadius,
						weight: w,
					},
				});
				bright.set(uniform(frame, 1));
				encoder.pass({ target: top, clear: [0, 0, 0, 0] }, (p) =>
					p.draw(bright)
				);
				for (const { larger, pass, smaller } of downs) {
					pass.set(uniform(larger, 1));
					encoder.pass({ target: smaller, clear: [0, 0, 0, 0] }, (p) =>
						p.draw(pass)
					);
				}
				for (let i = ups.length - 1; i >= 0; i -= 1) {
					const up = ups[i];
					// The loop stays within the list, so every step is there.
					if (!up) {
						continue;
					}
					up.pass.set(uniform(up.smaller, weight));
					encoder.pass({ target: up.larger, clear: false }, (p) =>
						p.draw(up.pass)
					);
				}
			}
			finish.set({
				finish: {
					vignetteColor: look.vignetteColor,
					vignette: look.vignette,
					bloom: glowing ? look.bloom / bloomGain(look.bloomRadius) : 0,
				},
			});
			encoder.pass({ target: finished }, finish);
			antialias.set({ antialias: { enabled: look.antialias ? 1 : 0 } });
			encoder.pass({ target: output }, antialias);
		},
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
			// The targets belong to the gpu: its dispose frees them.
		},
	};
}
