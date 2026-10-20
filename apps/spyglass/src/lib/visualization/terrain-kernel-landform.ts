import { unit } from "./geography";
import { geologyLevels, landformArchetypes } from "./geology";
import {
  defaultLandformSettings,
  type IslandLandform,
  type LandformSettings,
  sculpture,
} from "./landforms";
import { noiseSeed } from "./noise";
import { defaultTerrainSettings } from "./terrain";
import type { KernelMath } from "./terrain-kernel";
import type { KernelNoise } from "./terrain-kernel-noise";

/**
 * `landforms.ts` as a terrain kernel: every island's land at a position,
 * over any backend, from one flat record per island. The CPU keeps the
 * decisions (each island's formation, its vent or crest, its valleys'
 * courses, its seeds) and packs them into the record; the kernel holds
 * the arithmetic, the same op for op on the CPU and on the GPU. A parity
 * test runs the kernel on plain numbers against `landformFor`, so the two
 * copies of the maths cannot drift apart unseen.
 *
 * The atolls' lagoons, which `chart-world` carves over the landform with
 * `lagoonLandform`, are not part of the kernel yet.
 */

/** Valleys an island's record holds; the formations cut at most six. */
const kernelValleys = 8;
/** Hubs an island's record holds for a cluster's knolls; more are dropped. */
const kernelPeaks = 8;

/** Floats one valley takes in a record. */
const valleyStride = 10;
/** Floats one peak takes in a record. */
const peakStride = 3;

/** Where each value sits in an island's record. */
const islandSlots = {
  archetype: 0,
  beachHeight: 3,
  depth: 1,
  height: 2,
  meanderSeed: 10,
  /** Valleys first, then peaks, after the formation's own values. */
  peaks: 48 + kernelValleys * valleyStride,
  reach: 5,
  riser: 4,
  /** The formation's own values start here. */
  shape: 16,
  softness: 7,
  swellSeed: 8,
  terraces: 6,
  valleys: 48,
} as const;

/** Floats an island's record takes, a whole number of four-float texels. */
export const islandStride =
  Math.ceil((islandSlots.peaks + kernelPeaks * peakStride) / 4) * 4;

/** The formations' indices in a record; `ramp` is the fallback for an island without one. */
const kernelArchetypes = [...landformArchetypes, "ramp"] as const;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** A 32-bit seed as two exact 16-bit halves, high first. */
function seedHalves(seed: number): [number, number] {
  return [Math.floor(seed / 65_536), seed % 65_536];
}

/**
 * Every island's record, in the order of `islandIds` (the world terrain's
 * owner order): its formation's anatomy, its shape's constants, its
 * valleys' courses and its seeds, as `landforms.ts` derives them. Plain
 * numbers, so the CPU kernel reads them exactly; the GPU takes them as
 * single floats, seeds as 16-bit halves.
 */
export function packLandforms(
  landforms: ReadonlyMap<string, IslandLandform>,
  islandIds: readonly string[],
  settings: LandformSettings = defaultLandformSettings
): number[] {
  const values = new Array<number>(islandIds.length * islandStride).fill(0);
  for (const [index, id] of islandIds.entries()) {
    const record = (slot: number, value: number) => {
      values[index * islandStride + slot] = value;
    };
    const seedAt = (slot: number, text: string) => {
      const [high, low] = seedHalves(noiseSeed(text));
      record(slot, high);
      record(slot + 1, low);
    };
    const island = landforms.get(id);
    if (!island) {
      record(islandSlots.archetype, kernelArchetypes.indexOf("ramp"));
      record(islandSlots.reach, defaultTerrainSettings.land);
      continue;
    }
    const { archetype, params } = island;
    const formed = sculpture(archetype, params, id, settings);
    const { formation } = formed;
    // `profileParams`, `riserShare` and `beachWidth` of `landforms.ts`.
    const jitter = 1 - settings.variation * unit(`${id}:height`);
    const height = Math.min(
      geologyLevels.land,
      Math.max(0, formation.height * jitter * geologyLevels.land)
    );
    const beachHeight = Math.min(
      height,
      Math.max(0, settings.beach.height * geologyLevels.land)
    );
    const reach = Math.max(1, params.depth * formation.reach);
    const profileReach = Math.max(reach, 1e-3);
    const beach = Math.min(
      Math.max(settings.beach.width, 0),
      profileReach * 0.4
    );
    const step =
      (profileReach - beach) / Math.max(1, Math.round(formation.terraces));
    const riser = Math.min(
      1,
      Math.max(formation.riser, settings.minimumRiser / Math.max(step, 1e-6))
    );
    record(islandSlots.archetype, kernelArchetypes.indexOf(archetype));
    record(islandSlots.depth, params.depth);
    record(islandSlots.height, height);
    record(islandSlots.beachHeight, beachHeight);
    record(islandSlots.riser, riser);
    record(islandSlots.reach, reach);
    record(islandSlots.terraces, Math.max(1, Math.round(formation.terraces)));
    record(islandSlots.softness, clamp01(formation.softness));
    seedAt(islandSlots.swellSeed, `${id}:swell`);
    seedAt(islandSlots.meanderSeed, `${id}:meander`);
    packShape(archetype, params, id, settings, (slot, value) =>
      record(islandSlots.shape + slot, value)
    );
    seedAt(islandSlots.shape + 30, `${id}:lobes`);
    packValleys(formed.valleys, noiseSeed(`${id}:drainage`), (slot, value) =>
      record(islandSlots.valleys + slot, value)
    );
  }
  return values;
}

/**
 * An island's valleys into its record, as `drainage` prepares its courses:
 * each one's head, unit direction and length, its size, and its seed, the
 * island's offset by its index. Empty slots are unit courses of no depth,
 * which carve nothing.
 */
function packValleys(
  valleys: ReturnType<typeof sculpture>["valleys"],
  drainageSeed: number,
  record: (slot: number, value: number) => void
): void {
  for (let slot = 0; slot < kernelValleys; slot += 1) {
    const at = slot * valleyStride;
    const [high, low] = seedHalves(
      (drainageSeed + slot * 7919) % 4_294_967_296
    );
    const course = valleyCourse(valleys[slot]);
    for (const [offset, value] of [...course, high, low].entries()) {
      record(at + offset, value);
    }
  }
}

/**
 * One valley's course as `drainage` reads it: head, unit direction, length,
 * deepening, depth and half width. A missing or degenerate valley is a unit
 * course of no depth.
 */
function valleyCourse(
  valley: ReturnType<typeof sculpture>["valleys"][number] | undefined
): number[] {
  if (!valley) {
    return [0, 0, 1, 0, 1, 1, 0, 1];
  }
  const dx = valley.mouthX - valley.headX;
  const dy = valley.mouthY - valley.headY;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6 || valley.depth <= 0 || valley.width <= 0) {
    return [valley.headX, valley.headY, 1, 0, 1, 1, 0, 1];
  }
  return [
    valley.headX,
    valley.headY,
    dx / length,
    dy / length,
    length,
    Math.max(valley.deepen, 1e-3),
    clamp01(valley.depth),
    valley.width,
  ];
}

/**
 * The formation's own constants into the record's shape slots, as each
 * formation in `landforms.ts` derives them before it builds its relief.
 */
function packShape(
  archetype: IslandLandform["archetype"],
  params: IslandLandform["params"],
  seed: string,
  settings: LandformSettings,
  record: (slot: number, value: number) => void
): void {
  const seedAt = (slot: number, text: string) => {
    const [high, low] = seedHalves(noiseSeed(text));
    record(slot, high);
    record(slot + 1, low);
  };
  switch (archetype) {
    case "volcanic": {
      const volcano = settings.volcanic;
      const [hub] = params.peaks;
      const pull = hub ? volcano.ventPull : 1;
      const vent = {
        x: (hub?.x ?? params.x) + (params.x - (hub?.x ?? params.x)) * pull,
        y: (hub?.y ?? params.y) + (params.y - (hub?.y ?? params.y)) * pull,
      };
      const crater = Math.max(1, params.depth * volcano.crater);
      const offset = Math.hypot(vent.x - params.x, vent.y - params.y);
      const cone = Math.max(
        crater + 1,
        Math.max(params.length, params.breadth) * volcano.cone + offset
      );
      const flank = (distance: number) =>
        1 - (distance - crater) / (cone - crater);
      const side = unit(`${seed}:parasite`) < 0.5 ? -1 : 1;
      const parasite = {
        radius: Math.max(4, params.depth * volcano.parasite.radius),
        x:
          params.x +
          side * params.axis[0] * params.length * volcano.parasite.along,
        y:
          params.y +
          side * params.axis[1] * params.length * volcano.parasite.along,
      };
      const parasiteTop = Math.min(
        1,
        flank(Math.hypot(parasite.x - vent.x, parasite.y - vent.y)) +
          volcano.parasite.rise
      );
      record(0, vent.x);
      record(1, vent.y);
      record(2, crater);
      record(3, cone);
      record(4, parasite.x);
      record(5, parasite.y);
      record(6, parasite.radius);
      record(7, parasiteTop);
      return;
    }
    case "atoll": {
      const { fall, formation, motus } = settings.atoll;
      record(0, params.depth * formation.reach);
      record(1, Math.max(1, params.depth * fall));
      seedAt(2, `${seed}:motus`);
      record(4, motus.spacing);
      return;
    }
    case "plateau": {
      const { formation } = settings.plateau;
      record(0, 1 / Math.max(1, Math.round(formation.terraces)));
      seedAt(2, `${seed}:mesa`);
      return;
    }
    case "ridge": {
      const shape = settings.ridge;
      const breadth = Math.max(1, params.breadth);
      const length = Math.max(1, params.length);
      record(0, params.x);
      record(1, params.y);
      record(2, params.axis[0]);
      record(3, params.axis[1]);
      record(4, breadth);
      record(5, length);
      record(6, length * shape.shoulder);
      record(7, Math.max(8, length * shape.bend.wavelength));
      record(8, shape.bend.amount * breadth);
      seedAt(10, `${seed}:ridge-bend`);
      seedAt(12, `${seed}:ridge-spurs`);
      seedAt(14, `${seed}:ridge-saddles`);
      return;
    }
    case "cluster": {
      const shape = settings.cluster;
      const radius = Math.max(shape.knollMinimum, params.depth * shape.knoll);
      record(0, radius);
      record(1, radius * shape.lobes.wavelength);
      for (const [index, peak] of params.peaks
        .slice(0, kernelPeaks)
        .entries()) {
        const at = islandSlots.peaks - islandSlots.shape + index * peakStride;
        record(at, peak.x);
        record(at + 1, peak.y);
        record(
          at + 2,
          shape.knollWeight + (1 - shape.knollWeight) * clamp01(peak.weight)
        );
      }
      return;
    }
    case "seamount":
      return;
    default:
      throw new Error(`No kernel shape for ${archetype satisfies never}.`);
  }
}

/** Where the kernel asks for an island's land: the same as `LandformSample`, with the piece depth always known. */
export interface KernelSample<F> {
  inland: F;
  pieceDepth: F;
  x: F;
  y: F;
}

/**
 * One island's land at a sample, as `landformFor` gives it: 0 at the
 * coast, at most full land. `read` returns the island's record at a slot,
 * from the packed numbers on the CPU or a texture on the GPU.
 */
export function kernelLandform<F, U, B>(
  m: KernelMath<F, U, B>,
  noise: KernelNoise<F, U>,
  read: (slot: number) => F,
  sample: KernelSample<F>,
  settings: LandformSettings = defaultLandformSettings
): F {
  const smoothstep = (value: F): F => {
    const t = m.min(1, m.max(0, value));
    return m.mul(m.mul(t, t), m.sub(3, m.mul(2, t)));
  };
  const clamp = (value: F): F => m.min(1, m.max(0, value));
  const seed = (slot: number): U =>
    m.uintFromHalves(read(slot), read(slot + 1));
  const field = (
    wavelength: F | number,
    fractal: { gain: number; lacunarity: number; octaves: number },
    seedSlot: number
  ) =>
    noise.fbm(
      m.div(x, wavelength),
      m.div(y, wavelength),
      seed(seedSlot),
      fractal
    );
  const smooth2 = { gain: 0.5, lacunarity: 2, octaves: 2 };
  const shape = (slot: number) => read(islandSlots.shape + slot);
  const x = m.keep(sample.x);
  const y = m.keep(sample.y);
  const at = m.keep(m.max(0, sample.inland));

  const volcanic = (): F => {
    const volcano = settings.volcanic;
    const crater = shape(2);
    const cone = shape(3);
    const distance = m.hypot(m.sub(x, shape(0)), m.sub(y, shape(1)));
    const inside = m.sub(1, m.pow(m.div(distance, crater), 2));
    const inCrater = m.sub(
      1,
      m.mul(m.mul(volcano.craterDepth, inside), inside)
    );
    const t = m.div(m.hypot(m.sub(x, shape(4)), m.sub(y, shape(5))), shape(6));
    const knoll = m.select(
      m.lt(t, 1),
      m.mul(shape(7), m.pow(m.sub(1, m.mul(t, t)), 2)),
      0
    );
    const lobes = field(
      Math.max(volcano.lobes.wavelength, 1e-3),
      smooth2,
      islandSlots.shape + 30
    );
    const swell = m.mul(
      m.mul(volcano.lobes.amount, lobes),
      m.add(
        volcano.lobes.lip,
        m.mul(
          1 - volcano.lobes.lip,
          smoothstep(m.div(m.sub(distance, crater), crater))
        )
      )
    );
    const reached = m.add(
      crater,
      m.mul(m.sub(distance, crater), m.sub(1, swell))
    );
    const flank = m.sub(1, m.div(m.sub(reached, crater), m.sub(cone, crater)));
    return m.select(m.lt(distance, crater), inCrater, m.max(flank, knoll));
  };

  const atoll = (): F => {
    const { lagoon, motus } = settings.atoll;
    const ring = m.sub(
      1,
      m.mul(1 - lagoon, smoothstep(m.div(m.sub(at, shape(0)), shape(1))))
    );
    const islets = field(
      Math.max(motus.spacing, 1e-3),
      smooth2,
      islandSlots.shape + 2
    );
    const islet = smoothstep(
      m.div(m.sub(islets, motus.threshold), Math.max(motus.edge, 1e-3))
    );
    return m.mul(ring, m.add(motus.saddle, m.mul(1 - motus.saddle, islet)));
  };

  const plateau = (): F => {
    const { mesa } = settings.plateau;
    const mesas = field(
      Math.max(mesa.wavelength, 1e-3),
      { gain: 0.5, lacunarity: 2, octaves: mesa.octaves },
      islandSlots.shape + 2
    );
    return m.sub(
      1,
      m.mul(
        shape(0),
        smoothstep(
          m.div(m.sub(mesas, mesa.threshold), Math.max(mesa.edge, 1e-3))
        )
      )
    );
  };

  const ridge = (): F => {
    const ridgeSettings = settings.ridge;
    const dx = m.sub(x, shape(0));
    const dy = m.sub(y, shape(1));
    const ax = shape(2);
    const ay = shape(3);
    const breadth = shape(4);
    const length = shape(5);
    const shoulder = shape(6);
    const along = m.add(m.mul(dx, ax), m.mul(dy, ay));
    const across = m.sub(
      m.add(m.mul(m.mul(dx, -1), ay), m.mul(dy, ax)),
      m.mul(
        shape(8),
        noise.gradient(
          m.div(along, shape(7)),
          m.float(0.5),
          seed(islandSlots.shape + 10)
        )
      )
    );
    const flankRow = m.select(m.lt(across, 0), 3.5, 7.5);
    const spur = m.add(
      1,
      m.mul(
        ridgeSettings.spurs.reach,
        smoothstep(
          m.div(
            noise.gradient(
              m.div(along, ridgeSettings.spurs.wavelength),
              flankRow,
              seed(islandSlots.shape + 12)
            ),
            ridgeSettings.spurs.edge
          )
        )
      )
    );
    const crest = m.sub(
      1,
      m.pow(m.div(m.abs(across), m.mul(breadth, spur)), ridgeSettings.section)
    );
    const taper = m.sub(
      1,
      m.div(
        m.max(0, m.sub(m.abs(along), shoulder)),
        m.add(m.sub(length, shoulder), 1)
      )
    );
    const saddle = m.sub(
      1,
      m.mul(
        ridgeSettings.undulation.depth * 0.5,
        m.add(
          1,
          noise.gradient(
            m.div(along, ridgeSettings.undulation.wavelength),
            m.float(0.5),
            seed(islandSlots.shape + 14)
          )
        )
      )
    );
    return m.mul(m.mul(crest, taper), saddle);
  };

  const cluster = (): F => {
    const shapeSettings = settings.cluster;
    const lobes = field(m.max(shape(1), 1e-3), smooth2, islandSlots.shape + 30);
    const reach = m.mul(
      shape(0),
      m.add(1, m.mul(shapeSettings.lobes.amount, lobes))
    );
    let highest: F = m.float(shapeSettings.base);
    for (let index = 0; index < kernelPeaks; index += 1) {
      const peak = (slot: number) =>
        read(islandSlots.peaks + index * peakStride + slot);
      const t = m.div(m.hypot(m.sub(x, peak(0)), m.sub(y, peak(1))), reach);
      highest = m.select(
        m.lt(t, 1),
        m.max(highest, m.mul(peak(2), m.sub(1, m.mul(t, t)))),
        highest
      );
    }
    return highest;
  };

  const relief = m.branch(read(islandSlots.archetype), [
    volcanic,
    atoll,
    plateau,
    ridge,
    cluster,
    () => m.float(1),
    () => m.float(1),
  ]);

  // `drainage`: the deepest valley's carve.
  const { amplitude, wavelength: meanderWavelength } =
    settings.drainage.meander;
  const head = clamp01(settings.drainage.head);
  let carve: F = m.float(0);
  for (let index = 0; index < kernelValleys; index += 1) {
    const valley = (slot: number) =>
      read(islandSlots.valleys + index * valleyStride + slot);
    const px = m.sub(x, valley(0));
    const py = m.sub(y, valley(1));
    const directionX = valley(2);
    const directionY = valley(3);
    const along = m.add(m.mul(px, directionX), m.mul(py, directionY));
    const grown = smoothstep(m.div(along, valley(5)));
    const width = m.mul(valley(7), m.add(head, m.mul(1 - head, grown)));
    const offset = m.add(
      m.mul(px, m.mul(directionY, -1)),
      m.mul(py, directionX)
    );
    const wander = m.mul(
      m.mul(amplitude, grown),
      noise.gradient(
        m.div(along, meanderWavelength),
        m.float(0.5),
        m.uintFromHalves(valley(8), valley(9))
      )
    );
    const across = m.div(m.abs(m.sub(offset, wander)), width);
    const wall = m.sub(1, across);
    const cut = m.mul(m.mul(m.mul(valley(6), grown), wall), wall);
    const open = m.and(
      m.and(m.lt(0, along), m.lt(along, valley(4))),
      m.lt(across, 1)
    );
    carve = m.max(carve, m.select(open, cut, 0));
  }

  // `sculpted`: the inland distance swells and meanders, the relief is
  // capped by it and carved, then stepped into terraces over the beach.
  const piece = sample.pieceDepth;
  const beach = m.min(settings.beach.width, m.mul(settings.beach.share, piece));
  const strength = smoothstep(m.div(piece, settings.sculpt.full));
  const swell = field(
    Math.max(settings.sculpt.swell.wavelength, 1e-3),
    settings.sculpt.swell,
    islandSlots.swellSeed
  );
  const meander = field(
    Math.max(settings.sculpt.meander.wavelength, 1e-3),
    settings.sculpt.meander,
    islandSlots.meanderSeed
  );
  const sculptedInland = m.add(
    m.mul(
      at,
      m.add(1, m.mul(m.mul(strength, settings.sculpt.swell.amplitude), swell))
    ),
    m.mul(
      m.mul(m.mul(strength, settings.sculpt.meander.amplitude), meander),
      smoothstep(m.div(at, settings.beach.width))
    )
  );
  const reach = read(islandSlots.reach);
  const inlandRelief = clamp(
    m.div(m.sub(sculptedInland, beach), m.max(1, m.sub(reach, beach)))
  );
  const carved = m.mul(m.min(clamp(relief), inlandRelief), m.sub(1, carve));

  // `terrace`: each step opens with its escarpment, then holds a tread.
  const count = read(islandSlots.terraces);
  const u = clamp(carved);
  const scaled = m.mul(u, count);
  const step = m.min(m.sub(count, 1), m.floor(scaled));
  const rise = smoothstep(
    m.div(m.sub(scaled, step), m.max(read(islandSlots.riser), 1e-6))
  );
  const stepped = m.div(m.add(step, rise), count);
  const terraced = m.add(
    stepped,
    m.mul(read(islandSlots.softness), m.sub(u, stepped))
  );

  // `beachLip`: the bench's seaward face, then level sand.
  const beachHeight = read(islandSlots.beachHeight);
  const face = m.mul(beach, clamp01(settings.beach.lip));
  const lip = m.select(
    m.lt(0, face),
    m.mul(beachHeight, smoothstep(m.div(at, face))),
    m.select(m.lt(0, at), beachHeight, 0)
  );
  const elevation = m.add(
    lip,
    m.mul(m.sub(read(islandSlots.height), beachHeight), terraced)
  );
  const landform = m.min(geologyLevels.land, m.max(0, elevation));
  // The fallback: the structural terrain's straight ramp.
  const ramp = m.mul(
    geologyLevels.land - geologyLevels.waterLevel,
    m.min(1, m.div(at, m.max(reach, 1e-6)))
  );
  const isRamp = m.lt(
    kernelArchetypes.indexOf("ramp") - 0.5,
    read(islandSlots.archetype)
  );
  return m.select(
    m.lt(0, at),
    m.select(isRamp, m.add(geologyLevels.waterLevel, ramp), landform),
    0
  );
}
