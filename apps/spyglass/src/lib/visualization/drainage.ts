import { gradientNoise } from "./noise";

/**
 * Drainage: the valleys and ravines that cut an island's land from its
 * high ground down to the sea. A valley is a straight course from a head
 * inland to a mouth past the coast, where it ends, meandering across its course
 * with the seed. Its carve is a share of the land's relief taken away: none
 * at the head, deepening and widening over its first `deepen` map units,
 * and full on the valley's axis, falling to none at its walls in a V. A landform scales its
 * relief by one less the carve before it steps it, so the escarpments bend
 * upstream where a valley crosses them and the treads stay level.
 */

/** One valley's course and size, in map positions and map units. */
export interface Valley {
  /** Map units downstream of the head over which the valley deepens and widens to full. */
  deepen: number;
  /** Share of the relief the valley takes on its axis at full depth, 0 to 1. */
  depth: number;
  headX: number;
  headY: number;
  mouthX: number;
  mouthY: number;
  /** Half the valley's width at the mouth, in map units. */
  width: number;
}

export interface DrainageSettings {
  /** Half width at the head as a share of the half width at the mouth. */
  head: number;
  meander: {
    /** The furthest the axis wanders from the straight course, in map units. */
    amplitude: number;
    /** Map units along the course per lattice cell of the wandering. */
    wavelength: number;
  };
}

/** A valley ready to sample: its head, its course as a unit direction and its length. */
interface Course {
  deepen: number;
  depth: number;
  directionX: number;
  directionY: number;
  headX: number;
  headY: number;
  length: number;
  seed: number;
  width: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

/**
 * The carve of a set of valleys at any map position, 0 to 1: the deepest
 * valley's there, so a tributary joins its trunk without cutting deeper
 * than either. Each valley meanders with its own seed, derived from `seed`.
 */
export function drainage(
  valleys: readonly Valley[],
  seed: number,
  settings: DrainageSettings
): (x: number, y: number) => number {
  const courses: Course[] = valleys.flatMap((valley, index) => {
    const dx = valley.mouthX - valley.headX;
    const dy = valley.mouthY - valley.headY;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6 || valley.depth <= 0 || valley.width <= 0) {
      return [];
    }
    return [
      {
        deepen: Math.max(valley.deepen, 1e-3),
        depth: clamp01(valley.depth),
        directionX: dx / length,
        directionY: dy / length,
        headX: valley.headX,
        headY: valley.headY,
        length,
        seed: seed + index * 7919,
        width: valley.width,
      },
    ];
  });
  const { amplitude, wavelength } = settings.meander;
  const head = clamp01(settings.head);
  return (x, y) => {
    let carve = 0;
    for (const course of courses) {
      const px = x - course.headX;
      const py = y - course.headY;
      const along = px * course.directionX + py * course.directionY;
      if (along <= 0 || along >= course.length) {
        continue;
      }
      const grown = smoothstep(along / course.deepen);
      const width = course.width * (head + (1 - head) * grown);
      const offset = px * -course.directionY + py * course.directionX;
      if (Math.abs(offset) > width + amplitude) {
        continue;
      }
      const wander =
        amplitude * grown * gradientNoise(along / wavelength, 0.5, course.seed);
      const across = Math.abs(offset - wander) / width;
      if (across >= 1) {
        continue;
      }
      // A V in section: sharp on the axis, easing out to the walls.
      const wall = 1 - across;
      const cut = course.depth * grown * wall * wall;
      carve = Math.max(carve, cut);
    }
    return carve;
  };
}
