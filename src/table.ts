// A cue-sports table as data: its size, its pockets and cushions, its balls and its cloth. The physics, the aim, the
// bots and the drawing all read the same spec, so a new table (snooker's, a Brazilian bar table) is a new spec, not new
// code.
//
// The conventions, everywhere in the library:
// - Units are SI: meters, seconds, m/s, rad/s.
// - `x` runs across the table and `y` along it, from the head rail (y = 0, where the cue ball breaks from) to the foot
//   rail (y = length, where the rack sits). The playing surface is 0 to `width` by 0 to `length`, cushion nose to
//   cushion nose. Seen from above with the head rail at the bottom, `x` grows to the right.
// - Spins follow the right-hand rule around the axes (`z` is up), so a positive `wz` is counterclockwise seen from
//   above, and a ball rolling along +y has a negative `wx`.
// - Every ball on a table has the same radius and the same mass.

export interface Point {
  x: number
  y: number
}

/** A cushion's nose, from `from` to `to`, and the normal pointing into the table. */
export interface Cushion {
  from: Point
  to: Point
  nx: number
  ny: number
}

/** The table's shape: where a ball can go, bounce and fall. */
export interface TableShape {
  /** The playing surface, cushion nose to cushion nose. */
  width: number
  length: number
  /** The pockets' centers. A ball whose center comes `holeRadius` close falls in. */
  pockets: readonly Point[]
  holeRadius: number
  /** The cushions between the pockets. */
  cushions: readonly Cushion[]
  /** The rounded tips at each end of each cushion, turning it into the pocket. */
  jaws: readonly Point[]
  jawRadius: number
  /** Past the cushion line by this much, where no cushion stopped it, a ball is in the nearest pocket. */
  out: number
  headSpot: Point
  footSpot: Point
}

/** The balls and the cloth: how a ball moves on this table and what a hit does to it. */
export interface BallsAndCloth {
  ballRadius: number
  /** Cloth friction while a ball slides and while it rolls. */
  slide: number
  roll: number
  /** The cloth's friction against a ball spinning around its vertical axis (side spin), over the ball's radius. */
  spinning: number
  /** How much of the speed along the line of a hit survives it: ball on ball, ball on cushion. */
  ballRestitution: number
  /**
   * The friction between two balls: `a + b · e^(-c · slip)`, by how fast (m/s) their surfaces slip past each other
   * where they touch (Alciatore's fit, TP A-14). The slower the slip, the more they grip. All zeros: no friction.
   */
  ballFriction: BallFriction
  cushionRestitution: number
  /** The friction between a ball and a cushion, which turns side spin into a change of angle off it. */
  cushionFriction: number
  /** How high above the cloth a cushion's nose touches the ball (m): a little above its center. */
  cushionHeight: number
}

/** A table: its shape, and its balls and cloth. */
export interface TableSpec extends TableShape, BallsAndCloth {}

export interface BallFriction {
  a: number
  b: number
  c: number
}

/** Balls that hit each other without friction: no throw and no spin passed on. */
export const NO_BALL_FRICTION: BallFriction = { a: 0, b: 0, c: 0 }

export function cushion(ax: number, ay: number, bx: number, by: number): Cushion {
  const len = Math.hypot(bx - ax, by - ay)
  // The table is on the left of the way the cushion runs.
  return { from: { x: ax, y: ay }, to: { x: bx, y: by }, nx: -(by - ay) / len, ny: (bx - ax) / len }
}

/** Pool's ball: 2¼ inches across. */
export const POOL_BALL_RADIUS = 0.028575

/**
 * Pool balls of radius `ballRadius` on pool cloth, with pooltool's default numbers (Apache-2.0,
 * github.com/ekiefl/pooltool).
 */
export function poolBallsAndCloth(ballRadius: number = POOL_BALL_RADIUS): BallsAndCloth {
  return {
    ballRadius,
    slide: 0.2,
    roll: 0.01,
    // pooltool's defaults: spinning friction 10 · 2/5 / 9 of the radius, cushion friction 0.2.
    spinning: (10 * 2) / 5 / 9,
    ballRestitution: 0.95,
    ballFriction: { a: 0.009951, b: 0.108, c: 1.088 },
    cushionRestitution: 0.85,
    cushionFriction: 0.2,
    // WPA: the cushion's nose at 63.5% of the ball's height.
    cushionHeight: 0.635 * 2 * ballRadius,
  }
}

export interface PocketTableSize {
  width: number
  length: number
  /** How far each rail's cushion stops from a corner. */
  cornerMouth: number
  /** Half the gap of a side pocket. */
  sideMouth: number
  holeRadius: number
  jawRadius: number
}

/**
 * A table with six pockets (four corners and two sides) from its sizes. Its balls and cloth are pool's
 * (`poolBallsAndCloth`) unless `ballsAndCloth` says otherwise, one number or all of them: the cushion's height follows
 * the ball's radius when only the radius is given.
 */
export function sixPocketTable(size: PocketTableSize, ballsAndCloth: Partial<BallsAndCloth> = {}): TableSpec {
  const { width: W, length: L, cornerMouth: C, sideMouth: S, jawRadius } = size
  const cushions = [
    cushion(C, 0, W - C, 0),
    cushion(W - C, L, C, L),
    cushion(0, L / 2 - S, 0, C),
    cushion(0, L - C, 0, L / 2 + S),
    cushion(W, C, W, L / 2 - S),
    cushion(W, L / 2 + S, W, L - C),
  ]
  return {
    width: W,
    length: L,
    // The head corners, the sides, the foot corners.
    pockets: [
      { x: -0.016, y: -0.016 },
      { x: W + 0.016, y: -0.016 },
      { x: -0.03, y: L / 2 },
      { x: W + 0.03, y: L / 2 },
      { x: -0.016, y: L + 0.016 },
      { x: W + 0.016, y: L + 0.016 },
    ],
    holeRadius: size.holeRadius,
    cushions,
    jaws: cushions.flatMap((c) =>
      [c.from, c.to].map((p) => ({ x: p.x - jawRadius * c.nx, y: p.y - jawRadius * c.ny })),
    ),
    jawRadius,
    out: 0.04,
    headSpot: { x: W / 2, y: L / 4 },
    footSpot: { x: W / 2, y: (L * 3) / 4 },
    ...poolBallsAndCloth(ballsAndCloth.ballRadius),
    ...ballsAndCloth,
  }
}

const INCH = 0.0254
/** The playing surface's width (inches) of the standard pool tables, by their length in feet. Twice as long as wide. */
const POOL_WIDTHS = { 7: 39, 8: 44, 9: 50 } as const

/**
 * A standard pool table, 7, 8 or 9 feet long: the playing surface at its standard size, the pockets' mouths at the
 * WPA's narrowest (4½ inches at a corner, 5 at a side), pool's balls and cloth unless `ballsAndCloth` says otherwise.
 */
export function poolTable(feet: 7 | 8 | 9, ballsAndCloth?: Partial<BallsAndCloth>): TableSpec {
  const width = POOL_WIDTHS[feet] * INCH
  return sixPocketTable(
    {
      width,
      length: 2 * width,
      cornerMouth: (4.5 * INCH) / Math.SQRT2,
      sideMouth: 2.5 * INCH,
      holeRadius: 0.058,
      jawRadius: 0.008,
    },
    ballsAndCloth,
  )
}

/** The pocket nearest `p`, as an index in the table's `pockets`. */
export function nearestPocket(table: TableShape, p: Point): number {
  let best = 0
  let bestD = Infinity
  table.pockets.forEach((q, i) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d < bestD) {
      best = i
      bestD = d
    }
  })
  return best
}
