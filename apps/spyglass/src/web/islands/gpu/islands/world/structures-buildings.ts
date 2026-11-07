/**
 * What each kind of building is made of (world.ts `BuildingKind`), as parts
 * of the kit in town-parts.ts, in the building's own frame: its footprint's
 * middle at the origin, its front and door toward its road along +z. Every
 * building is at the one human scale (`STOREY`, `DOOR_HEIGHT`) and grows by
 * floors and parts, never by scaling.
 *
 * The look follows REFERENCES.md: two-storey houses under grey, blue-grey
 * and green roofs with deep eaves, some with a wing, a bay, a balcony or a
 * car port; walk-ups with an outside stair and an open corridor; blocks
 * with a balcony on every floor; a lit convenience store with its vending
 * machines; low public buildings; a shrine behind its torii; dark
 * boathouses with their gables to the sea; a white lighthouse. Every choice
 * is hashed from the building's place, so the same plan builds the same
 * town and a changed file repaints only its own building.
 */
import type { Point } from "../../../data/chart";
import {
  COLORS,
  lightWallPaint,
  type Paint,
  pickOf,
  roofPaint,
  wallPaint,
} from "./structures-palette";
import {
  DOOR_HEIGHT,
  FACES,
  STOREY,
  type TownPart,
  townPart,
  type WindowStyle,
} from "./town-parts";
import type { Building } from "./world";

/** A site of its own for a group of parts, in the building's frame; parts holding the same object share it. */
export interface Spot {
  readonly at: Point;
  readonly half: readonly [number, number];
}

/** A part, and the spot it stands on if not the building's own footprint. */
export interface Laid {
  readonly part: TownPart;
  readonly spot?: Spot;
}

/** The parcel's extent in the building's frame: how much room is round it. */
export interface Room {
  readonly maxX: number;
  readonly maxZ: number;
  readonly minX: number;
  readonly minZ: number;
}

const QUARTER_TURN = Math.PI / 2;
/** How far a parapet rises over a flat roof. */
const PARAPET = 0.15;
/** A roof's rise over half its span: about 24 degrees. */
const PITCH = 0.45;
/** A balcony's or a corridor's half depth, and its panel over its floor. */
const BALCONY_HALF = 0.17;
const PANEL = 0.3;
/** Height of a door's head: canopies and sign bands sit over it. */
const DOOR_TOP = DOOR_HEIGHT + 0.08;
/** A tier of a stand: how much higher than the one in front. */
const TIER_RISE = 0.3;
const TIER_DEPTH = 0.5;

/** The independent choices a building makes, by salt (structures-palette.ts `pickOf`). */
const SALTS = {
  balcony: 11,
  bay: 12,
  carPort: 13,
  extra: 14,
  overhang: 6,
  pitch: 7,
  roofShade: 4,
  roofStyle: 10,
  roofTone: 3,
  side: 9,
  wallShade: 2,
  wallTone: 1,
  windows: 5,
  wing: 8,
} as const;

type Pick = (salt: keyof typeof SALTS) => number;
const picker =
  (b: Building): Pick =>
  (salt) =>
    pickOf(b.at, SALTS[salt]);

const clamp = (x: number, low: number, high: number): number =>
  Math.min(Math.max(x, low), high);

/** How a roof sits on its body. */
type RoofStyle = "ridgeX" | "ridgeZ" | "hipped";

interface Body {
  readonly at: Point;
  readonly half: readonly [number, number];
  /** The walls' top, where the roof's slopes cross them. */
  readonly top: number;
}

/**
 * A pitched roof over a body: gabled with its ridge across (x) or along
 * (z) the street, or hipped, at `pitch` with `overhang` past the walls.
 * The roof part's own ridge runs along its local z, so a ridge along x is
 * the part turned a quarter.
 */
function roofOn(
  body: Body,
  style: RoofStyle,
  roof: Paint,
  ends: Paint,
  overhang: number,
  pitch = PITCH
): TownPart {
  const [hx, hz] = body.half;
  const alongX = style === "ridgeX" || (style === "hipped" && hx > hz);
  const half: readonly [number, number] = alongX ? [hz, hx] : [hx, hz];
  return townPart({
    at: body.at,
    base: body.top,
    color: roof.color,
    half,
    hipped: style === "hipped",
    material: roof.material,
    overhang,
    rise: pitch * half[0],
    shades: true,
    shape: "roof",
    trim: ends.material,
    trimColor: ends.color,
    turn: alongX ? QUARTER_TURN : 0,
  });
}

/**
 * A lean-to: one slope from `high` at its back down to its front, over a
 * footprint of `half` (across, deep) whose back is toward −z.
 */
function leanTo(
  at: Point,
  half: readonly [number, number],
  base: number,
  rise: number,
  color: string,
  material: TownPart["material"] = "seam",
  overhang = 0.05
): TownPart {
  // Turned a quarter, the roof's −x (its high side) is the building's −z.
  return townPart({
    at,
    base,
    color,
    half: [half[1], half[0]],
    material,
    overhang,
    rise,
    shape: "roof",
    shed: true,
    trim: "plaster",
    trimColor: color,
    turn: QUARTER_TURN,
  });
}

/** A box of walls with windows, under eaves unless flat-topped. */
function walls(
  body: Body,
  paint: Paint,
  fields: Partial<TownPart> = {}
): TownPart {
  return townPart({
    at: body.at,
    color: paint.color,
    eaved: true,
    half: body.half,
    material: paint.material,
    shape: "box",
    wall: body.top,
    windows: true,
    ...fields,
  });
}

/** A balcony's open rail across `half[0]`, standing out from a front at `front`. */
function balcony(
  x: number,
  front: number,
  halfAcross: number,
  base: number,
  floors: number,
  color: string,
  turn = 0
): TownPart {
  return townPart({
    // Out from the front: +z, or −z for one turned round to a back.
    at: [x, front + Math.cos(turn) * BALCONY_HALF],
    base,
    color,
    half: [halfAcross, BALCONY_HALF],
    material: "panel",
    shape: "open",
    style: "balcony",
    turn,
    wall: (floors - 1) * STOREY + PANEL,
  });
}

/** A thin flat box: a canopy's slab, a sign, a rail. */
function slab(
  at: Point,
  half: readonly [number, number],
  base: number,
  wall: number,
  material: TownPart["material"],
  color: string | null = null,
  fields: Partial<TownPart> = {}
): TownPart {
  return townPart({
    at,
    base,
    color,
    half,
    material,
    shape: "box",
    wall,
    ...fields,
  });
}

const windowsOf = (pick: number): WindowStyle => {
  if (pick < 0.5) {
    return "sash";
  }
  return pick < 0.85 ? "sliding" : "narrow";
};

const roofStyleOf = (pick: number): RoofStyle => {
  if (pick < 0.42) {
    return "ridgeX";
  }
  return pick < 0.62 ? "ridgeZ" : "hipped";
};

/** The side of a building with more room beside it within its parcel, and how much. */
function openSide(
  b: Building,
  room: Room | null
): { side: -1 | 1; free: number } {
  const [hx] = b.half;
  if (!room) {
    return { free: 0, side: pickOf(b.at, SALTS.side) < 0.5 ? -1 : 1 };
  }
  const right = room.maxX - hx;
  const left = -room.minX - hx;
  return right >= left ? { free: right, side: 1 } : { free: left, side: -1 };
}

/** A car port beside a house: a clear slab on two posts on its open side, toward the road. */
function carPort(b: Building, room: Room | null): Laid[] {
  const { side, free } = openSide(b, room);
  if (free < 0.75) {
    return [];
  }
  const [hx, hz] = b.half;
  const across = Math.min(0.42, (free - 0.12) / 2);
  const deep = Math.min(0.62, hz);
  const reachFront = room ? room.maxZ - 0.1 : hz;
  const cz = Math.min(hz - deep + 0.35, reachFront - deep);
  const cx = side * (hx + 0.06 + across);
  const height = 0.56;
  const posts: Laid[] = [-1, 1].map((end) => ({
    part: slab(
      [cx + side * (across - 0.03), cz + end * (deep - 0.06)],
      [0.022, 0.022],
      0,
      height,
      "steel",
      COLORS.aluminium
    ),
  }));
  return [
    ...posts,
    {
      part: slab(
        [cx, cz],
        [across + 0.04, deep + 0.04],
        height,
        0.03,
        "seam",
        COLORS.clearRoof
      ),
    },
  ];
}

/** An air conditioner's outdoor unit against a side wall. */
const outdoorUnit = (x: number, z: number, side: number): TownPart =>
  slab([x + side * 0.06, z], [0.06, 0.11], 0, 0.13, "metal", COLORS.unit);

/** A detached house: two storeys, a pitched roof, and its own mix of wing, bay, balcony and car port. */
function house(b: Building, room: Room | null): Laid[] {
  const pick = picker(b);
  const [hx, hz] = b.half;
  const storeys = clamp(b.storeys || 2, 1, 2);
  const top = storeys * STOREY;
  const wall = wallPaint(pick("wallTone"), pick("wallShade"));
  const roof = roofPaint(pick("roofTone"), pick("roofShade"));
  const windowStyle = windowsOf(pick("windows"));
  const overhang = 0.15 + 0.04 * pick("overhang");
  const pitch = PITCH + 0.06 * (pick("pitch") - 0.5);
  const winged = hx >= 0.75 && storeys > 1 && pick("wing") < 0.35;
  const wingSide = pick("side") < 0.5 ? -1 : 1;
  const mainHalf = winged ? hx * 0.64 : hx;
  const mainX = winged ? -wingSide * (hx - mainHalf) : 0;
  const main: Body = { at: [mainX, 0], half: [mainHalf, hz], top };
  const laid: Laid[] = [
    { part: walls(main, wall, { doors: FACES.north, windowStyle }) },
    {
      part: roofOn(
        main,
        roofStyleOf(pick("roofStyle")),
        roof,
        wall,
        overhang,
        pitch
      ),
    },
  ];
  if (winged) {
    // A one-storey wing on one side, set back or forward.
    const inner = mainX + wingSide * mainHalf;
    const outer = wingSide * hx;
    const wingHalfX = Math.abs(outer - inner) / 2;
    const wingHalfZ = hz * 0.7;
    const forward = pick("extra") < 0.5 ? 1 : -1;
    const wing: Body = {
      at: [(inner + outer) / 2, forward * (hz - wingHalfZ)],
      half: [wingHalfX, wingHalfZ],
      top: STOREY,
    };
    laid.push(
      { part: walls(wing, wall, { windowStyle: "sliding" }) },
      {
        part: roofOn(
          wing,
          pick("pitch") < 0.5 ? "hipped" : "ridgeZ",
          roof,
          wall,
          overhang * 0.8,
          pitch
        ),
      }
    );
  }
  if (storeys > 1 && pick("balcony") < 0.55) {
    const across = Math.min(mainHalf * 0.8, 0.75);
    const offset = winged ? 0 : (pick("side") - 0.5) * (mainHalf - across);
    laid.push({
      part: balcony(
        mainX + offset,
        hz,
        across,
        STOREY,
        1,
        pick("extra") < 0.5 ? wall.color : COLORS.aluminium
      ),
    });
  } else {
    // A small canopy over the door.
    laid.push({
      part: leanTo(
        [mainX, hz + 0.15],
        [0.34, 0.15],
        DOOR_TOP + 0.04,
        0.06,
        roof.color
      ),
    });
  }
  if (!winged && pick("bay") < 0.3) {
    // A bay on the ground storey to one side of the door.
    const bx = mainX - wingSide * mainHalf * 0.5;
    laid.push(
      {
        part: walls(
          { at: [bx, hz + 0.12], half: [0.3, 0.12], top: 0.58 },
          wall,
          { windowStyle: "sliding" }
        ),
      },
      { part: leanTo([bx, hz + 0.14], [0.34, 0.16], 0.58, 0.08, roof.color) }
    );
  }
  if (pick("carPort") < 0.6) {
    laid.push(...carPort(b, room));
  }
  const { side } = openSide(b, room);
  laid.push({ part: outdoorUnit(-side * hx, -hz * 0.4, -side) });
  return laid;
}

/** A pair of semi-detached houses under one roof: a door, a balcony and a canopy each. */
function pair(b: Building): Laid[] {
  const pick = picker(b);
  const [hx, hz] = b.half;
  const storeys = clamp(b.storeys || 2, 1, 2);
  const body: Body = { at: [0, 0], half: [hx, hz], top: storeys * STOREY };
  const wall = lightWallPaint(pick("wallTone"), pick("wallShade"));
  const roof = roofPaint(pick("roofTone"), pick("roofShade"));
  const laid: Laid[] = [
    {
      part: walls(body, wall, {
        doorRow: 2,
        windowStyle: windowsOf(pick("windows")),
      }),
    },
    {
      part: roofOn(
        body,
        pick("roofStyle") < 0.7 ? "ridgeX" : "hipped",
        roof,
        wall,
        0.14
      ),
    },
  ];
  for (const side of [-1, 1]) {
    const x = (side * hx) / 2;
    laid.push({
      part: leanTo(
        [x, hz + 0.15],
        [0.3, 0.15],
        DOOR_TOP + 0.04,
        0.06,
        roof.color
      ),
    });
    if (storeys > 1) {
      laid.push({
        part: balcony(
          x + side * 0.15,
          hz,
          Math.min(0.5, hx / 2 - 0.2),
          STOREY,
          1,
          COLORS.aluminium
        ),
      });
    }
  }
  return laid;
}

const STAIR_HALF = 0.28;

/** A walk-up: an outside stair at one end, an open corridor along the front on every upper floor. */
function walkup(b: Building): Laid[] {
  const pick = picker(b);
  const [hx, hz] = b.half;
  const storeys = clamp(b.storeys || 2, 2, 3);
  const top = storeys * STOREY;
  const side = pick("side") < 0.5 ? -1 : 1;
  const wall = lightWallPaint(pick("wallTone"), pick("wallShade"));
  const roof = roofPaint(pick("roofTone") * 0.8, pick("roofShade"));
  const flat = pick("roofStyle") < 0.45;
  const bodyHalfX = hx - STAIR_HALF;
  const bodyX = -side * STAIR_HALF;
  const body: Body = {
    at: [bodyX, -BALCONY_HALF],
    half: [bodyHalfX, hz - BALCONY_HALF],
    top,
  };
  const perFloor = clamp(Math.ceil(b.files.length / storeys), 2, 4);
  const laid: Laid[] = [
    {
      part: walls(body, wall, {
        doorRow: perFloor,
        eaved: !flat,
        parapet: flat,
        rowEvery: true,
        shades: flat,
        wall: flat ? top + PARAPET : top,
        windowStyle: "narrow",
      }),
    },
    {
      part: balcony(
        bodyX,
        hz - 2 * BALCONY_HALF,
        bodyHalfX,
        STOREY,
        storeys - 1,
        wall.color
      ),
    },
    {
      part: townPart({
        at: [side * (hx - STAIR_HALF), 0],
        color: COLORS.aluminium,
        half: [STAIR_HALF, hz],
        material: "steel",
        shape: "open",
        style: "stair",
        wall: (storeys - 1) * STOREY + PANEL,
      }),
    },
  ];
  if (!flat) {
    // A shallow metal roof over the body and the corridor.
    laid.push({
      part: roofOn(
        { at: [bodyX, 0], half: [bodyHalfX, hz], top },
        "ridgeX",
        { color: roof.color, material: "seam" },
        wall,
        0.1,
        0.3
      ),
    });
  }
  return laid;
}

/**
 * An apartment block or a tower: a balcony on every floor above the
 * ground (on both long sides for a tower), a flat roof behind a parapet
 * with its stair housing, an entrance canopy, and on some a water tank.
 */
function apartments(b: Building, tower: boolean): Laid[] {
  const pick = picker(b);
  const [hx, hz] = b.half;
  const storeys = Math.max(b.storeys, tower ? 6 : 3);
  const top = storeys * STOREY;
  const wall = lightWallPaint(pick("wallTone"), pick("wallShade"));
  const depth = tower ? 2 * BALCONY_HALF : BALCONY_HALF;
  const body: Body = {
    at: [0, tower ? 0 : -BALCONY_HALF],
    half: [hx, hz - depth],
    top: top + PARAPET,
  };
  const front = body.at[1] + body.half[1];
  const railColor = pick("extra") < 0.5 ? COLORS.aluminium : wall.color;
  const laid: Laid[] = [
    {
      part: walls(body, wall, {
        doors: FACES.north,
        eaved: false,
        parapet: true,
        shades: true,
        windowStyle: tower ? "sash" : "narrow",
      }),
    },
    {
      part: slab(
        [hx * (pick("side") - 0.5), body.at[1] - body.half[1] * 0.3],
        [0.5, 0.4],
        top,
        STOREY * 0.8 + PARAPET,
        wall.material,
        wall.color,
        { doors: FACES.north, parapet: true }
      ),
    },
    {
      part: slab([0, front + 0.22], [0.45, 0.22], DOOR_TOP, 0.06, "concrete"),
    },
    {
      part: balcony(0, front, hx - 0.15, STOREY, storeys - 1, railColor),
    },
  ];
  if (tower) {
    laid.push(
      {
        part: balcony(
          0,
          -front,
          hx - 0.15,
          STOREY,
          storeys - 1,
          railColor,
          Math.PI
        ),
      },
      {
        part: slab(
          [-hx * (pick("side") - 0.5), 0],
          [0.025, 0.025],
          top + PARAPET,
          0.9,
          "steel"
        ),
      }
    );
  }
  if (tower || pick("bay") < 0.4) {
    laid.push({
      part: townPart({
        at: [-hx * (pick("side") - 0.5) * 0.8, body.at[1] + body.half[1] * 0.3],
        base: top + PARAPET,
        color: "#c9c9c3",
        half: [0.32, 0.32],
        material: "grey",
        overhang: 0.03,
        rise: 0.08,
        shape: "round",
        trim: "grey",
        trimColor: "#b9b9b3",
        wall: 0.42,
      }),
    });
  }
  return laid;
}

/** The convenience store: one storey, glazed and lit along its front, its sign band, vending machines by the door. */
function store(b: Building): Laid[] {
  const pick = picker(b);
  const [hx, hz] = b.half;
  const wall = 0.85;
  const laid: Laid[] = [
    {
      part: townPart({
        doors: FACES.north,
        half: [hx, hz],
        material: "white",
        parapet: true,
        shades: true,
        shape: "box",
        shopfront: true,
        wall: wall + PARAPET,
      }),
    },
    {
      part: slab(
        [0, hz + 0.03],
        [hx, 0.03],
        DOOR_TOP + 0.06,
        wall - DOOR_TOP + 0.04,
        "sign"
      ),
    },
  ];
  const side = pick("side") < 0.5 ? -1 : 1;
  for (const [k, color] of ["#c63a32", "#e9e8e2"].entries()) {
    laid.push({
      part: slab(
        [side * (hx - 0.14 - k * 0.24), hz + 0.12],
        [0.11, 0.08],
        0,
        0.46,
        "vending",
        color
      ),
    });
  }
  return laid;
}

/** A public building: a town hall, a post office, a clinic: low and long, a ribbon of windows, a canopy and a flagpole. */
function civic(b: Building): Laid[] {
  const pick = picker(b);
  const [hx, hz] = b.half;
  const storeys = clamp(b.storeys || 2, 2, 3);
  const wall = lightWallPaint(pick("wallTone") * 0.7 + 0.3, pick("wallShade"));
  const top = storeys * STOREY + PARAPET;
  return [
    {
      part: walls({ at: [0, 0], half: [hx, hz], top }, wall, {
        doors: FACES.north,
        eaved: false,
        parapet: true,
        shades: true,
        windowStyle: "ribbon",
      }),
    },
    {
      part: slab(
        [0, hz + 0.32],
        [0.8, 0.32],
        DOOR_TOP + 0.04,
        0.07,
        "concrete"
      ),
    },
    {
      part: slab(
        [hx * 0.7, hz + 0.6],
        [0.02, 0.02],
        0,
        2.2,
        "steel",
        COLORS.aluminium
      ),
    },
  ];
}

/** The station: a long low hall under a hipped roof, a platform and its canopy behind. */
function station(b: Building): Laid[] {
  const pick = picker(b);
  const [hx, hz] = b.half;
  const hallHalfZ = hz * 0.55;
  const hallZ = hz - hallHalfZ;
  const platformHalfZ = hz - hallHalfZ;
  const platformZ = -hz + platformHalfZ;
  const roof = roofPaint(pick("roofTone") * 0.8, pick("roofShade"));
  const hall: Body = { at: [0, hallZ], half: [hx * 0.8, hallHalfZ], top: 0.95 };
  const hallWall = wallPaint(0.1, pick("wallShade"));
  const canopyHeight = 0.72;
  const laid: Laid[] = [
    {
      part: walls(hall, hallWall, {
        doors: FACES.north + FACES.south,
        windowStyle: "sliding",
      }),
    },
    { part: roofOn(hall, "hipped", roof, hallWall, 0.18, 0.5) },
    {
      part: slab([0, hz + 0.02], [0.6, 0.02], 0.78, 0.14, "white", "#f4f2ea"),
    },
    {
      part: slab([0, platformZ], [hx, platformHalfZ], 0, 0.12, "concrete"),
    },
    {
      part: leanTo(
        [0, platformZ + 0.05],
        [hx * 0.95, platformHalfZ * 0.75],
        canopyHeight,
        0.1,
        roof.color
      ),
    },
  ];
  const posts = 4;
  for (let k = 0; k < posts; k += 1) {
    const x = (k / (posts - 1) - 0.5) * 2 * hx * 0.85;
    laid.push({
      part: slab(
        [x, platformZ + platformHalfZ * 0.3],
        [0.025, 0.025],
        0,
        canopyHeight + 0.05,
        "steel"
      ),
    });
  }
  return laid;
}

/** The school: long, two or three storeys, a ribbon of windows, a clock tower over its entrance. */
function school(b: Building): Laid[] {
  const pick = picker(b);
  const [hx, hz] = b.half;
  const storeys = clamp(b.storeys || 3, 2, 3);
  const top = storeys * STOREY + PARAPET;
  const wall = lightWallPaint(pick("wallTone") * 0.6, pick("wallShade"));
  const towerHalf: readonly [number, number] = [0.36, 0.3];
  const towerTop = top + 0.62;
  return [
    {
      part: walls({ at: [0, 0], half: [hx, hz], top }, wall, {
        eaved: false,
        parapet: true,
        shades: true,
        windowStyle: "ribbon",
      }),
    },
    {
      part: slab(
        [0, hz - towerHalf[1] + 0.06],
        towerHalf,
        0,
        towerTop,
        wall.material,
        wall.color,
        { doors: FACES.north, parapet: true, shades: true }
      ),
    },
    {
      part: slab([0, hz + 0.075], [0.17, 0.012], top + 0.1, 0.34, "clock"),
    },
    {
      part: slab([0, hz + 0.36], [0.6, 0.3], DOOR_TOP + 0.04, 0.06, "concrete"),
    },
  ];
}

/** A utility: a grey substation box, or a water tank. */
function utility(b: Building): Laid[] {
  const pick = picker(b);
  const [hx, hz] = b.half;
  if (pick("extra") < 0.5) {
    return [
      {
        part: slab([0, 0], [hx, hz], 0, 0.55, "metal", "#a4aaae", {
          doors: FACES.north,
          shades: true,
        }),
      },
    ];
  }
  const r = Math.min(hx, hz);
  return [
    {
      part: townPart({
        color: "#c4c4be",
        half: [r, r],
        material: "grey",
        overhang: 0.03,
        rise: 0.14,
        shades: true,
        shape: "round",
        trim: "grey",
        trimColor: "#b0b0aa",
        wall: 0.95,
      }),
    },
  ];
}

const TORII_HEIGHT = 0.82;
const TORII_HALF = 0.3;

/** A torii across a path at `z`: two vermilion posts, two beams, a black cap. */
function torii(z: number): Laid[] {
  const spot: Spot = { at: [0, z], half: [TORII_HALF + 0.12, 0.08] };
  const posts: Laid[] = [-1, 1].map((side) => ({
    part: townPart({
      at: [side * TORII_HALF, z],
      color: COLORS.vermilion,
      half: [0.036, 0.036],
      material: "lacquer",
      overhang: 0,
      shape: "round",
      trim: "lacquer",
      trimColor: COLORS.vermilion,
      wall: TORII_HEIGHT,
    }),
    spot,
  }));
  const beam = (
    half: readonly [number, number],
    base: number,
    wall: number,
    color: string
  ): Laid => ({
    part: slab([0, z], half, base, wall, "lacquer", color),
    spot,
  });
  return [
    ...posts,
    beam(
      [TORII_HALF + 0.08, 0.03],
      TORII_HEIGHT - 0.24,
      0.05,
      COLORS.vermilion
    ),
    beam(
      [TORII_HALF + 0.1, 0.045],
      TORII_HEIGHT - 0.06,
      0.06,
      COLORS.vermilion
    ),
    beam([TORII_HALF + 0.16, 0.055], TORII_HEIGHT, 0.055, COLORS.torii),
  ];
}

/** A shrine: a small dark hall on a stone plinth under a curved roof, its torii toward the road. */
function shrine(b: Building, room: Room | null): Laid[] {
  const pick = picker(b);
  const [hx, hz] = b.half;
  const plinth = 0.12;
  const hall: Body = {
    at: [0, -hz * 0.1],
    half: [hx * 0.72, hz * 0.6],
    top: plinth + 0.55,
  };
  const roofColor = pick("roofTone") < 0.6 ? COLORS.copper : "#3a3d42";
  const front = hall.at[1] + hall.half[1];
  const laid: Laid[] = [
    { part: slab([0, 0], [hx, hz], 0, plinth, "concrete", "#9c988e") },
    {
      part: walls(
        hall,
        { color: COLORS.darkTimber, material: "timber" },
        {
          base: plinth,
          doors: FACES.north,
          wall: hall.top - plinth,
          windows: false,
        }
      ),
    },
    {
      part: townPart({
        at: hall.at,
        base: hall.top,
        color: roofColor,
        curved: true,
        half: [hall.half[1], hall.half[0]],
        material: "seam",
        overhang: 0.22,
        rise: 0.42,
        shades: true,
        shape: "roof",
        trim: "timber",
        trimColor: COLORS.darkTimber,
        turn: QUARTER_TURN,
      }),
    },
    {
      part: leanTo(
        [0, front + 0.2],
        [0.32, 0.2],
        hall.top - 0.1,
        0.12,
        roofColor,
        "seam",
        0.06
      ),
    },
    {
      part: slab(
        [0, front + 0.3],
        [0.26, 0.14],
        0,
        plinth + 0.04,
        "concrete",
        "#9c988e"
      ),
    },
  ];
  const toward = room ? room.maxZ - 0.2 : hz + 1.2;
  const z = Math.max(Math.min(hz + 1.1, toward), hz + 0.35);
  laid.push(...torii(z));
  return laid;
}

/** A stand along a pitch: tiers rising away from its front, a back wall, and on a long one a roof on posts. */
function stand(b: Building): Laid[] {
  const [hx, hz] = b.half;
  const tiers = clamp(Math.round((2 * hz) / TIER_DEPTH), 1, 4);
  const depth = (2 * hz) / tiers;
  const blocks = Math.max(Math.round(hx / 0.7), 1);
  const laid: Laid[] = [];
  for (let k = 0; k < tiers; k += 1) {
    laid.push({
      part: townPart({
        at: [0, hz - depth * (k + 0.5)],
        color: "#4f6f8c",
        half: [hx, depth / 2],
        material: "seats",
        places: blocks,
        shades: k === tiers - 1,
        shape: "box",
        wall: TIER_RISE * (k + 1),
      }),
    });
  }
  const backTop = TIER_RISE * tiers + 0.3;
  laid.push({
    part: slab([0, -hz + 0.03], [hx, 0.03], 0, backTop, "concrete"),
  });
  if (hx > 2) {
    const roofBase = backTop + 0.45;
    laid.push({
      part: leanTo(
        [0, 0.05],
        [hx, hz + 0.1],
        roofBase,
        0.14,
        "#8e969c",
        "seam",
        0.04
      ),
    });
    const posts = Math.max(Math.round(hx / 1.5), 2);
    for (let k = 0; k <= posts; k += 1) {
      laid.push({
        part: slab(
          [(k / posts - 0.5) * 2 * (hx - 0.1), -hz + 0.08],
          [0.03, 0.03],
          0,
          roofBase + 0.14,
          "steel"
        ),
      });
    }
  }
  return laid;
}

/**
 * A boathouse in the shore row (Ine no Funaya): dark timber, two storeys,
 * its front (+z, which the plan turns to the sea) a gable over a ground
 * storey open as a boat slip, its door at the back to the shore path.
 */
function boathouse(b: Building): Laid[] {
  const pick = picker(b);
  const [hx, hz] = b.half;
  const top = 2 * STOREY;
  const roof = roofPaint(pick("roofTone") * 0.8, pick("roofShade") * 0.5);
  const timber = pick("wallShade") < 0.85 ? COLORS.darkTimber : "#6a5442";
  const body: Body = { at: [0, 0], half: [hx, hz], top };
  const laid: Laid[] = [
    {
      part: walls(
        body,
        { color: timber, material: "timber" },
        {
          bay: true,
          doors: FACES.south,
          shades: false,
          windowStyle: "sparse",
        }
      ),
    },
    {
      part: roofOn(
        body,
        "ridgeZ",
        roof,
        { color: timber, material: "timber" },
        0.13,
        0.55
      ),
    },
  ];
  if (pick("balcony") < 0.35) {
    laid.push({
      part: balcony(0, hz, hx * 0.7, STOREY, 1, timber),
    });
  }
  return laid;
}

const LIGHTHOUSE_HEIGHT = 2.9;

/** A lighthouse: a white round tower with a band, its gallery, and its lamp under a cap. */
function lighthouse(b: Building): Laid[] {
  const r = clamp(Math.min(...b.half) * 0.8, 0.3, 0.45);
  return [
    {
      part: townPart({
        banded: true,
        color: COLORS.lighthouse,
        doors: FACES.north,
        half: [r, r],
        material: "white",
        overhang: 0,
        shades: true,
        shape: "round",
        trim: "red",
        trimColor: COLORS.lighthouseBand,
        wall: LIGHTHOUSE_HEIGHT,
      }),
    },
    {
      part: townPart({
        base: LIGHTHOUSE_HEIGHT,
        half: [r + 0.07, r + 0.07],
        material: "steel",
        overhang: 0.1,
        shape: "round",
        trim: "steel",
        wall: 0.06,
      }),
    },
    {
      part: townPart({
        base: LIGHTHOUSE_HEIGHT + 0.06,
        half: [r * 0.75, r * 0.75],
        material: "lamp",
        overhang: 0.06,
        rise: 0.28,
        shape: "round",
        trim: "red",
        trimColor: COLORS.lighthouseBand,
        wall: 0.38,
      }),
    },
  ];
}

/** The parts a building is made of, in its own frame. */
export function partsOf(b: Building, room: Room | null): Laid[] {
  switch (b.kind) {
    case "house":
      return house(b, room);
    case "pair":
      return pair(b);
    case "walkup":
      return walkup(b);
    case "block":
      return apartments(b, false);
    case "tower":
      return apartments(b, true);
    case "store":
      return store(b);
    case "civic":
      return civic(b);
    case "station":
      return station(b);
    case "school":
      return school(b);
    case "utility":
      return utility(b);
    case "shrine":
      return shrine(b, room);
    case "stand":
      return stand(b);
    case "boathouse":
      return boathouse(b);
    case "lighthouse":
      return lighthouse(b);
    default:
      return house(b, room);
  }
}
