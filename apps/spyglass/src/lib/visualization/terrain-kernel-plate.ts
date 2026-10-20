import type { KernelMath } from "./terrain-kernel";

/**
 * The geology preview's plate term as a terrain kernel: the seabed's light
 * across a terrace plate, 1 on its tread, a pale lip where the tread ends
 * and the riser below, shaded by its bearing to the sun. `geology-layer`'s
 * `plateShade` is the CPU original; the screen terrain builds this one into
 * its material, so a test holds the two together.
 */
export interface PlateSettings {
  deep: { from: number; gain: number; to: number };
  depth: { from: number; to: number };
  lip: { away: number; strength: number; width: number };
  pixels: number;
  riser: { away: number; foot: number; toward: number };
  spacing: { from: number; to: number };
  tread: { from: number; to: number };
}

/** Below this many units per pixel a field is flat, and no edge is drawn on it. */
const flatFootprint = 1e-6;

/** How far a unit normal tilts before its bearing to the sun counts. */
const facingTilt = { from: 0.01, to: 0.04 };

/**
 * The plate's light. `coordinate` is the contour coordinate, `footprint`
 * its change across a screen pixel, `normal` the geometric normal, world x
 * right and y up, `sun` the sun's bearing on the chart, x right and y up,
 * unit length, and `depth` the nominal metres of water.
 */
export function kernelPlate<F, U, B>(
  m: KernelMath<F, U, B>,
  sample: {
    coordinate: F;
    depth: F;
    footprint: F;
    normal: readonly [F, F, F];
  },
  sun: readonly [number, number],
  settings: PlateSettings
): F {
  const smooth = (from: F | number, to: F | number, value: F | number): F => {
    const t = m.min(1, m.max(0, m.div(m.sub(value, from), m.sub(to, from))));
    return m.mul(m.mul(t, t), m.sub(3, m.mul(2, t)));
  };
  const [nx, ny, nz] = sample.normal;
  const length = m.max(
    m.sqrt(m.add(m.add(m.mul(nx, nx), m.mul(ny, ny)), m.mul(nz, nz))),
    1e-12
  );
  const tilt = m.div(m.hypot(nx, ny), length);
  const bearing = m.div(
    m.add(m.mul(nx, sun[0]), m.mul(ny, sun[1])),
    m.mul(length, m.max(tilt, flatFootprint))
  );
  const facing = m.select(
    m.lt(flatFootprint, tilt),
    m.mul(bearing, smooth(facingTilt.from, facingTilt.to, tilt)),
    0
  );
  const { footprint } = sample;
  const half = m.div(m.max(footprint, flatFootprint), 2);
  const offset = m.sub(
    m.sub(sample.coordinate, m.floor(sample.coordinate)),
    0.5
  );
  const below = m.max(0, m.mul(offset, -1));
  const above = m.max(0, offset);
  const lipEdge = m.add(
    settings.tread.to,
    m.max(settings.lip.width, m.mul(footprint, settings.pixels))
  );
  const pastLip = smooth(m.sub(lipEdge, half), m.add(lipEdge, half), below);
  const lip = m.mul(
    smooth(settings.tread.from, settings.tread.to, below),
    m.sub(1, pastLip)
  );
  const riser = m.max(
    pastLip,
    smooth(settings.tread.from, settings.riser.foot, above)
  );
  const lift = m.mul(
    settings.lip.strength,
    m.sub(1, m.mul(settings.lip.away, m.max(0, m.mul(facing, -1))))
  );
  const shade = m.sub(
    m.mul(settings.riser.toward, m.max(0, facing)),
    m.mul(settings.riser.away, m.max(0, m.mul(facing, -1)))
  );
  const resolved = m.select(
    m.lt(footprint, flatFootprint),
    0,
    smooth(
      settings.spacing.from,
      settings.spacing.to,
      m.div(1, m.max(footprint, flatFootprint))
    )
  );
  const deepened = m.add(
    1,
    m.mul(
      settings.deep.gain,
      smooth(settings.deep.from, settings.deep.to, sample.depth)
    )
  );
  return m.max(
    0,
    m.add(
      1,
      m.mul(
        m.mul(
          m.mul(m.add(m.mul(lip, lift), m.mul(riser, shade)), resolved),
          smooth(settings.depth.from, settings.depth.to, sample.depth)
        ),
        deepened
      )
    )
  );
}
