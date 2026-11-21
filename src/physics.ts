import { cushion, nearestPocket, type BallsAndCloth, type Cushion, type Point, type TableSpec } from "./table.ts"

// Cue-sports physics, one event at a time (Leckie & Greenspan, "An event-based pool physics simulator", 2006). The
// motion models follow pooltool (Apache-2.0, github.com/ekiefl/pooltool). Between two events (a hit, a ball starting to
// roll, a ball stopping) every ball moves on a formula, a parabola in time, so the simulation jumps straight to the
// next event instead of stepping through time, and a whole shot is a short list of states: the `Track` the table plays
// back. Nothing here uses randomness: the same table, balls and shot give the same result. The table (its size, pockets,
// cushions and cloth) comes in as a `TableSpec`.
//
// The cue can strike the cue ball off center (`Spin`): above or below gives it topspin or backspin, which the cloth
// turns into follow or draw once the cue ball has hit a ball; to a side gives it side spin, which the cloth slowly wears
// away and a cushion turns into a change of angle (Han 2005). The cue ball goes straight where it's aimed (no squirt).
// A shot is the strike and then the run: `simulate` is `strike` on the cue ball, then `run` on the table. `run` alone
// takes balls already moving, whatever set them going.
//
// Two balls rub where they touch (`collide`): a cut or a side spin throws the ball hit a little off the line between
// the centers, and some spin passes from one ball to the other. A table whose `ballFriction` is all zeros has none of
// it. Nothing leaves the cloth: a hit's pull up or down changes the spin and never the height.

const G = 9.81
/** The least speed (m/s) two things part at after touching. */
const MIN_PART = 0.002
/** A speed or a slip below this (m/s) is zero. */
const STILL = 1e-6
/** A side spin below this (rad/s) is zero. */
const NO_SPIN = 1e-3
/** A run that hasn't settled after this many events stops where it is, unless `RunOptions.maxEvents` says otherwise. */
export const MAX_EVENTS = 20_000
/** The farthest the cue tip may hit from the cue ball's center, as a part of its radius: past it, a miscue. */
export const TIP_REACH = 0.5

/** "spinning" is a ball that stays in place while its side spin wears away. */
export type Motion = "still" | "sliding" | "rolling" | "pocketed" | "spinning"

/** What a caller got wrong: `code` tells which, the message is for a developer. */
export class BilliardsError extends Error {
  /**
   * - `no_cue_ball`: `simulate` strikes ball 0, and it's missing or pocketed.
   * - `ball_order`: a ball isn't at its id's index in the list.
   * - `bad_table`: the table's cushions can't touch its balls: `cushionHeight` isn't from 0 to the ball's height.
   */
  readonly code: "no_cue_ball" | "ball_order" | "bad_table"

  constructor(code: BilliardsError["code"], message: string) {
    super(message)
    this.name = "BilliardsError"
    this.code = code
  }
}

export interface Ball {
  /** The ball's index in the table's list. 0 is the cue ball, for whatever strikes one (`simulate`). */
  id: number
  x: number
  y: number
  vx: number
  vy: number
  /**
   * Spin around the table's x and y axes (rad/s). Rolling ties it to the velocity (`wx = -vy / R`, `wy = vx / R`);
   * sliding is when they disagree, and the cloth's friction pulls them together.
   */
  wx: number
  wy: number
  /** Spin around the vertical axis (rad/s, counterclockwise from above): side spin, from a cue hitting off center. */
  wz: number
  motion: Motion
  /** The pocket it fell in (an index in the table's `pockets`), while `motion` is "pocketed". */
  pocket: number | null
}

/** A ball at rest. */
export function restingBall(id: number, x: number, y: number): Ball {
  return { id, x, y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, motion: "still", pocket: null }
}

/**
 * Where the cue tip hits the cue ball, from the shooter's side: `side` from -1 (left) to 1 (right), `top` from -1
 * (low: draw) to 1 (high: follow), each as a part of the farthest the tip may be off center, inside the unit circle.
 */
export interface Spin {
  side: number
  top: number
}

/** `spin` pulled back onto the unit circle from outside it: past the edge, the tip would miss. */
export function clampSpin(spin: Spin): Spin {
  const r = Math.hypot(spin.side, spin.top)
  return r > 1 ? { side: spin.side / r, top: spin.top / r } : spin
}

/** The speed (m/s) that rolls a ball `d` meters on this table's cloth before it stops. */
export function rollingSpeed(table: BallsAndCloth, d: number): number {
  return Math.sqrt(2 * table.roll * G * d)
}

// ---------------------------------------------------------------------------------------------------------------
// One ball's motion until its next change: r(t) = c + b t + a t², for t from 0 to `until`.

interface Path {
  ax: number
  ay: number
  bx: number
  by: number
  cx: number
  cy: number
  until: number
  /** |b| and |a|: how fast it starts and how fast it slows, for `reach`. */
  speed: number
  accel: number
}

/** Going somewhere: a ball that only spins in place isn't. */
const moving = (b: Ball): boolean => b.motion === "sliding" || b.motion === "rolling"

/** How fast the cloth wears the side spin away (rad/s²), the same however the ball moves. */
const spinDecay = (table: BallsAndCloth): number => (5 * table.spinning * G) / 2

/** The slip: how fast the point touching the cloth moves. Zero when the ball rolls. */
function slip(R: number, b: Ball): { ux: number; uy: number } {
  return { ux: b.vx - R * b.wy, uy: b.vy + R * b.wx }
}

function path(table: BallsAndCloth, b: Ball): Path {
  if (b.motion === "sliding") {
    const { ux, uy } = slip(table.ballRadius, b)
    const u = Math.hypot(ux, uy)
    const k = (table.slide * G) / 2
    return {
      speed: Math.sqrt(b.vx * b.vx + b.vy * b.vy),
      accel: k,
      ax: (-k * ux) / u,
      ay: (-k * uy) / u,
      bx: b.vx,
      by: b.vy,
      cx: b.x,
      cy: b.y,
      until: (2 * u) / (7 * table.slide * G),
    }
  }
  if (b.motion === "rolling") {
    const v = Math.hypot(b.vx, b.vy)
    const k = (table.roll * G) / 2
    return {
      speed: v,
      accel: k,
      ax: (-k * b.vx) / v,
      ay: (-k * b.vy) / v,
      bx: b.vx,
      by: b.vy,
      cx: b.x,
      cy: b.y,
      until: v / (table.roll * G),
    }
  }
  const until = b.motion === "spinning" ? Math.abs(b.wz) / spinDecay(table) : Infinity
  return { ax: 0, ay: 0, bx: 0, by: 0, cx: b.x, cy: b.y, until, speed: 0, accel: 0 }
}

/**
 * Where `b` is `dt` seconds later, if nothing touches it. It never goes past the end of its current motion (the slide
 * turning into a roll, the roll stopping, the spin in place running out): the simulation puts an event there, and the
 * table's playback has a state right after it.
 */
export function evolve(table: BallsAndCloth, b: Ball, dt: number): Ball {
  if (dt <= 0 || b.motion === "still" || b.motion === "pocketed") return b
  const R = table.ballRadius
  const p = path(table, b)
  const t = Math.min(dt, p.until)
  // The side spin wears away on its own, at the same rate however the ball moves.
  const left = Math.abs(b.wz) - spinDecay(table) * t
  const wz = left > 0 ? Math.sign(b.wz) * left : 0
  if (b.motion === "spinning") return { ...b, wz }
  const x = p.cx + p.bx * t + p.ax * t * t
  const y = p.cy + p.by * t + p.ay * t * t
  const vx = p.bx + 2 * p.ax * t
  const vy = p.by + 2 * p.ay * t
  if (b.motion === "rolling") return { ...b, x, y, vx, vy, wx: -vy / R, wy: vx / R, wz }
  // Sliding: the cloth's friction at the contact point spins the ball up toward rolling.
  const { ux, uy } = slip(R, b)
  const u = Math.hypot(ux, uy)
  const k = ((5 * table.slide * G) / (2 * R)) * t
  return { ...b, x, y, vx, vy, wx: b.wx - (k * uy) / u, wy: b.wy + (k * ux) / u, wz }
}

/**
 * `b` with the motion its velocity and spin say: sliding while the point touching the cloth slips, rolling when it
 * doesn't, spinning or still when the ball goes nowhere. A pocketed ball stays pocketed. For a ball put together by
 * hand: `run` does this to every ball it's given, `evolve` trusts the motion it reads.
 */
export function withMotion(table: BallsAndCloth, b: Ball): Ball {
  return b.motion === "pocketed" ? b : settle(table.ballRadius, b)
}

/** The motion that matches the ball's velocity and spin, after a hit changed them. */
function settle(R: number, b: Ball): Ball {
  const { ux, uy } = slip(R, b)
  if (Math.hypot(ux, uy) > STILL) return { ...b, motion: "sliding" }
  return roll(R, b)
}

function roll(R: number, b: Ball): Ball {
  if (Math.hypot(b.vx, b.vy) > STILL) return { ...b, motion: "rolling", wx: -b.vy / R, wy: b.vx / R }
  return rest(b)
}

/** A ball that stopped: still, or spinning in place while it has side spin left. */
function rest(b: Ball): Ball {
  const stopped = { ...b, vx: 0, vy: 0, wx: 0, wy: 0 }
  return Math.abs(b.wz) > NO_SPIN ? { ...stopped, motion: "spinning" } : { ...stopped, wz: 0, motion: "still" }
}

// ---------------------------------------------------------------------------------------------------------------
// Polynomials in t, lowest power first, and the first time one of them reaches zero from above.

type Poly = number[]

function at(c: Poly, t: number): number {
  let s = 0
  for (let i = c.length - 1; i >= 0; i--) s = s * t + (c[i] as number)
  return s
}

function degree(c: Poly): number {
  let d = c.length - 1
  while (d > 0 && c[d] === 0) d--
  return d
}

/** The points in (lo, hi) where `c` turns around, so it only goes one way between two of them. */
function turns(c: Poly, lo: number, hi: number): number[] {
  const d = degree(c)
  if (d <= 1) return []
  const slope: Poly = []
  for (let i = 1; i <= d; i++) slope.push((c[i] as number) * i)
  return roots(slope, lo, hi)
}

/** Every point in (lo, hi) where `c` changes sign, in order. */
function roots(c: Poly, lo: number, hi: number): number[] {
  const d = degree(c)
  if (d === 0) return []
  if (d === 1) {
    const r = -(c[0] as number) / (c[1] as number)
    return r > lo && r < hi ? [r] : []
  }
  const between = turns(c, lo, hi)
  const out: number[] = []
  let a = lo
  let fa = at(c, a)
  for (let i = 0; i <= between.length; i++) {
    const b = i < between.length ? (between[i] as number) : hi
    const fb = at(c, b)
    if (fa > 0 && fb < 0) out.push(cross(c, 1, a, fa, b, fb))
    else if (fa < 0 && fb > 0) out.push(cross(c, -1, a, fa, b, fb))
    a = b
    fa = fb
  }
  return out
}

/**
 * Where `sign · c` goes from above zero (at `a`, where `c` is `fa`) to zero or below (at `b`, where it's `fb`).
 * Returns the first time at or below zero. With `sign` -1, it's where `c` comes up from below.
 *
 * By the Illinois method: each step cuts where the straight line between the two ends meets zero, and an end that
 * stays put twice in a row has its value halved, so both ends close in. The two ends always keep the zero between
 * them, so what comes back is never before it.
 */
function cross(c: Poly, sign: 1 | -1, a: number, fa: number, b: number, fb: number): number {
  let lo = a
  let hi = b
  let flo = sign * fa
  let fhi = sign * fb
  /** Which end the last step moved: 1 for `lo`, -1 for `hi`. */
  let moved = 0
  for (let i = 0; i < 80 && hi - lo > 1e-13; i++) {
    let mid = hi - (fhi * (hi - lo)) / (fhi - flo)
    if (!(mid > lo && mid < hi)) mid = (lo + hi) / 2
    const f = sign * at(c, mid)
    if (f > 0) {
      lo = mid
      flo = f
      if (moved === 1) fhi /= 2
      moved = 1
    } else {
      hi = mid
      fhi = f
      if (moved === -1) flo /= 2
      moved = -1
    }
  }
  return hi
}

/**
 * The first time in [0, hi] when `c` comes down to zero: two things start to touch. If they already touch (a rounding
 * can leave them a hair inside each other), it's the first time they close in: now, or where a curving path turns
 * back into the other before they ever came apart.
 */
function firstTouch(c: Poly, hi: number): number | null {
  const between = turns(c, 0, hi)
  let a = 0
  let fa = at(c, a)
  for (let i = 0; i <= between.length; i++) {
    const b = i < between.length ? (between[i] as number) : hi
    const fb = at(c, b)
    if (fa <= 0) {
      if (fb < fa) return a
    } else if (fb <= 0) return cross(c, 1, a, fa, b, fb)
    a = b
    fa = fb
  }
  return null
}

/** |p(t) - q(t)|² - d², for two paths (or a path and a still point). */
function distancePoly(p: Path, q: Path, d: number): Poly {
  const Ax = p.ax - q.ax
  const Ay = p.ay - q.ay
  const Bx = p.bx - q.bx
  const By = p.by - q.by
  const Cx = p.cx - q.cx
  const Cy = p.cy - q.cy
  return [
    Cx * Cx + Cy * Cy - d * d,
    2 * (Bx * Cx + By * Cy),
    Bx * Bx + By * By + 2 * (Ax * Cx + Ay * Cy),
    2 * (Ax * Bx + Ay * By),
    Ax * Ax + Ay * Ay,
  ]
}

/** The distance from the line to the path, along the line's normal, minus `d`. */
function linePoly(p: Path, line: Cushion, d: number): Poly {
  return [
    line.nx * (p.cx - line.from.x) + line.ny * (p.cy - line.from.y) - d,
    line.nx * p.bx + line.ny * p.by,
    line.nx * p.ax + line.ny * p.ay,
  ]
}

const still = (p: Point): Path => ({
  ax: 0,
  ay: 0,
  bx: 0,
  by: 0,
  cx: p.x,
  cy: p.y,
  until: Infinity,
  speed: 0,
  accel: 0,
})

/** How far a path can get from where it starts within `t`. */
function reach(p: Path, t: number): number {
  return p.speed * t + p.accel * t * t
}

/** Whether `p`, `d` or nearer to (x, y), could get there within `t`: if not, there's no touch to look for. */
function within(p: Path, x: number, y: number, d: number, t: number): boolean {
  const dx = p.cx - x
  const dy = p.cy - y
  const near = d + reach(p, t)
  return dx * dx + dy * dy <= near * near
}

function positionAt(p: Path, t: number): Point {
  return { x: p.cx + p.bx * t + p.ax * t * t, y: p.cy + p.by * t + p.ay * t * t }
}

// ---------------------------------------------------------------------------------------------------------------
// The events.

type Next =
  | { dt: number; type: "change"; ball: number }
  | { dt: number; type: "ball"; ball: number; other: number }
  | { dt: number; type: "cushion"; ball: number; nx: number; ny: number }
  | { dt: number; type: "jaw"; ball: number; jaw: number }
  | { dt: number; type: "pocket"; ball: number; pocket: number }

/** The lines past the cushions: crossing one, where a pocket's mouth let it through, puts the ball in that pocket. */
function outLines(table: TableSpec): Cushion[] {
  const { width: W, length: L, out } = table
  return [
    cushion(0, -out, 1, -out),
    cushion(1, L + out, 0, L + out),
    cushion(-out, 1, -out, 0),
    cushion(W + out, 0, W + out, 1),
  ]
}

/**
 * When balls `a` and `b` first touch, if before `soonest` (seconds from now) and before either changes how it moves.
 * Two balls that both stay in place never do.
 */
function pairTouch(R: number, a: Ball, b: Ball, pa: Path, pb: Path, soonest: number): number | null {
  if (a.motion === "pocketed" || b.motion === "pocketed" || (!moving(a) && !moving(b))) return null
  const hi = Math.min(pa.until, pb.until, soonest)
  if (!within(pa, pb.cx, pb.cy, 2 * R + reach(pb, hi), hi)) return null
  const t = firstTouch(distancePoly(pa, pb, 2 * R), hi)
  return t !== null && t < soonest ? t : null
}

/**
 * The first part of the table a moving ball reaches, if before `soonest` (seconds from now) and before it changes how
 * it moves: a cushion, a jaw, a pocket, or the line past a pocket's mouth.
 */
function tableTouch(table: TableSpec, outs: readonly Cushion[], b: Ball, p: Path, soonest: number): Next | null {
  const R = table.ballRadius
  let best: Next | null = null
  for (const c of table.cushions) {
    const hi = Math.min(p.until, soonest)
    const poly = linePoly(p, c, R)
    if ((poly[0] as number) > reach(p, hi)) continue
    const t = firstTouch(poly, hi)
    if (t === null || t >= soonest) continue
    // Only where the cushion is: past its ends, the jaws and the pocket take over.
    const hit = positionAt(p, t)
    const dx = c.to.x - c.from.x
    const dy = c.to.y - c.from.y
    const s = ((hit.x - c.from.x) * dx + (hit.y - c.from.y) * dy) / (dx * dx + dy * dy)
    if (s >= 0 && s <= 1) {
      best = { dt: t, type: "cushion", ball: b.id, nx: c.nx, ny: c.ny }
      soonest = t
    }
  }
  for (let k = 0; k < table.jaws.length; k++) {
    const jaw = table.jaws[k] as Point
    const hi = Math.min(p.until, soonest)
    if (!within(p, jaw.x, jaw.y, R + table.jawRadius, hi)) continue
    const t = firstTouch(distancePoly(p, still(jaw), R + table.jawRadius), hi)
    if (t !== null && t < soonest) {
      best = { dt: t, type: "jaw", ball: b.id, jaw: k }
      soonest = t
    }
  }
  for (let k = 0; k < table.pockets.length; k++) {
    const hole = table.pockets[k] as Point
    const hi = Math.min(p.until, soonest)
    if (!within(p, hole.x, hole.y, table.holeRadius, hi)) continue
    const t = firstTouch(distancePoly(p, still(hole), table.holeRadius), hi)
    if (t !== null && t < soonest) {
      best = { dt: t, type: "pocket", ball: b.id, pocket: k }
      soonest = t
    }
  }
  for (const line of outs) {
    const hi = Math.min(p.until, soonest)
    const poly = linePoly(p, line, 0)
    if ((poly[0] as number) > reach(p, hi)) continue
    const t = firstTouch(poly, hi)
    if (t !== null && t < soonest) {
      best = { dt: t, type: "pocket", ball: b.id, pocket: nearestPocket(table, positionAt(p, t)) }
      soonest = t
    }
  }
  return best
}

/**
 * The soonest event on the table. Each check only looks up to the soonest found so far, and ties go to what's checked
 * first: a ball changing how it moves, then two balls touching, then a ball and the table.
 */
function nextEvent(
  table: TableSpec,
  outs: readonly Cushion[],
  balls: readonly Ball[],
  paths: readonly Path[],
): Next | null {
  const R = table.ballRadius
  let best: Next | null = null
  let soonest = Infinity

  for (let i = 0; i < balls.length; i++) {
    const until = (paths[i] as Path).until
    if (until < soonest) {
      best = { dt: until, type: "change", ball: i }
      soonest = until
    }
  }

  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      const t = pairTouch(R, balls[i] as Ball, balls[j] as Ball, paths[i] as Path, paths[j] as Path, soonest)
      if (t !== null) {
        best = { dt: t, type: "ball", ball: i, other: j }
        soonest = t
      }
    }
  }

  for (let i = 0; i < balls.length; i++) {
    const b = balls[i] as Ball
    if (!moving(b)) continue
    const hit = tableTouch(table, outs, b, paths[i] as Path, soonest)
    if (hit) {
      best = hit
      soonest = hit.dt
    }
  }
  return best
}

/**
 * Two balls touching. Along the line between their centers they trade speed, less what the hit loses. Two balls pressed
 * together (a sliding ball curving into the one it just hit) part at least at `MIN_PART`: without it, they would touch
 * again an instant later, forever.
 *
 * Across that line the two surfaces rub (pooltool's frictional inelastic model, after Alciatore's TP A-5, A-6 and
 * A-14): the friction pulls against the slip between them, as hard as the hit pushed times the friction, and no harder
 * than what stops the slip (a seventh of it, for two equal balls). It pushes the two balls opposite ways and turns
 * both the same way, so a cut or a side spin throws the ball hit off the line, and spin passes between them.
 *
 * `a` and `b` are the two balls as they touch (their centers two radii apart, though only the direction between them is
 * read), and what comes back is the two right after, each with its new motion. Balls already parting only keep parting.
 */
export function collide(table: BallsAndCloth, a: Ball, b: Ball): [Ball, Ball] {
  const e = table.ballRestitution
  const R = table.ballRadius
  const d = Math.hypot(b.x - a.x, b.y - a.y)
  const nx = (b.x - a.x) / d
  const ny = (b.y - a.y) / d
  const va = a.vx * nx + a.vy * ny
  const vb = b.vx * nx + b.vy * ny
  let na = va
  let nb = vb
  if (va > vb) {
    na = ((1 - e) * va + (1 + e) * vb) / 2
    nb = ((1 + e) * va + (1 - e) * vb) / 2
  }
  if (nb - na < MIN_PART) {
    const mid = (na + nb) / 2
    na = mid - MIN_PART / 2
    nb = mid + MIN_PART / 2
  }
  // The slip: how fast a's surface passes b's where they touch, along the cloth (x, y) and up (z).
  const wx = a.wx + b.wx
  const wy = a.wy + b.wy
  const wz = a.wz + b.wz
  const sx = a.vx - b.vx - (va - vb) * nx - R * wz * ny
  const sy = a.vy - b.vy - (va - vb) * ny + R * wz * nx
  const sz = R * (wx * ny - wy * nx)
  const slipSpeed = Math.hypot(sx, sy, sz)
  // What the friction adds to a's velocity, and takes from b's.
  let fx = 0
  let fy = 0
  let fz = 0
  const push = nb - vb
  if (slipSpeed > STILL && push > 0) {
    const { a: floor, b: rise, c: fade } = table.ballFriction
    const friction = floor + rise * Math.exp(-fade * slipSpeed)
    const pull = Math.min(friction * push, slipSpeed / 7)
    fx = (-pull * sx) / slipSpeed
    fy = (-pull * sy) / slipSpeed
    fz = (-pull * sz) / slipSpeed
  }
  // The same pull at the touching point turns both balls the same way: (5 / 2R) n × f.
  const k = 5 / (2 * R)
  const turn = { wx: k * ny * fz, wy: -k * nx * fz, wz: k * (nx * fy - ny * fx) }
  return [
    settle(R, {
      ...a,
      vx: a.vx + (na - va) * nx + fx,
      vy: a.vy + (na - va) * ny + fy,
      wx: a.wx + turn.wx,
      wy: a.wy + turn.wy,
      wz: a.wz + turn.wz,
    }),
    settle(R, {
      ...b,
      vx: b.vx + (nb - vb) * nx - fx,
      vy: b.vy + (nb - vb) * ny - fy,
      wx: b.wx + turn.wx,
      wy: b.wy + turn.wy,
      wz: b.wz + turn.wz,
    }),
  ]
}

/**
 * Off a cushion or a jaw whose normal (into the table) is `n`, by Han's model (2005, "Dynamics in carom and three
 * cushion billiards", as pooltool has it): the cushion's nose touches the ball above its center, so the hit's friction
 * works on the ball's spin. Side spin bends the angle it comes off at, topspin and backspin change how it leaves.
 *
 * `b` is the ball as it touches and (nx, ny) a unit vector (a `Cushion` carries its own); what comes back is the ball
 * right after, with its new motion.
 */
export function bounce(table: BallsAndCloth, b: Ball, nx: number, ny: number): Ball {
  const R = table.ballRadius
  // The cushion's frame: X into the cushion, Y along it (X turned a quarter counterclockwise), Z up.
  const x = { x: -nx, y: -ny }
  const y = { x: ny, y: -nx }
  let vX = b.vx * x.x + b.vy * x.y
  let vY = b.vx * y.x + b.vy * y.y
  if (vX <= 0) {
    // Touching but already leaving (a rounding): only make sure it parts.
    vX = Math.min(vX, -MIN_PART)
    return settle(R, { ...b, vx: vX * x.x + vY * y.x, vy: vX * x.y + vY * y.y })
  }
  let wX = b.wx * x.x + b.wy * x.y
  let wY = b.wx * y.x + b.wy * y.y
  let wZ = b.wz
  const theta = Math.asin(table.cushionHeight / R - 1)
  const sin = Math.sin(theta)
  const cos = Math.cos(theta)
  const mu = table.cushionFriction
  // The slip at the contact (eqs 14), and the impulses per unit mass (eqs 16 to 22): A = 7/2, B = 1.
  const sx = vX * sin + R * wY
  const sy = -vY - R * wZ * cos + R * wX * sin
  const A = 7 / 2
  const pzE = (1 + table.cushionRestitution) * vX * cos
  const s = Math.hypot(sx, sy)
  // Sticking: the friction stops the slip within the hit. Sliding: it slips all through, with the friction's whole pull.
  const [pxE, pyE] = s / A <= mu * pzE ? [sx / A, sy / A] : [(mu * pzE * sx) / s, (mu * pzE * sy) / s]
  const pX = -pxE * sin - pzE * cos
  const pY = pyE
  const pZ = pxE * cos - pzE * sin
  const I = (2 / 5) * R * R
  vX = Math.min(vX + pX, -MIN_PART)
  vY += pY
  wX += (-R / I) * pY * sin
  wY += (R / I) * (pX * sin - pZ * cos)
  wZ += (R / I) * pY * cos
  return settle(R, {
    ...b,
    vx: vX * x.x + vY * y.x,
    vy: vX * x.y + vY * y.y,
    wx: wX * x.x + wY * y.x,
    wy: wX * x.y + wY * y.y,
    wz: wZ,
  })
}

// ---------------------------------------------------------------------------------------------------------------
// The shot and its playback.

/**
 * A ball's state from time `t` on, as a compact list of 9 numbers: it's what a server sends for a table to play back.
 *
 * | index | what | unit |
 * | --- | --- | --- |
 * | 0 | `t`, when the state starts | s |
 * | 1, 2 | `x`, `y` | m |
 * | 3, 4 | `vx`, `vy` | m/s |
 * | 5, 6 | `wx`, `wy` | rad/s |
 * | 7 | the motion, as an index in `MOTIONS` | |
 * | 8 | `wz`, the side spin (it came last) | rad/s |
 *
 * Read one with `keyTime`, `keyMotion` and `fromKeyframe` rather than by index, and write one with `toKeyframe`.
 */
export type Keyframe = [number, number, number, number, number, number, number, number, number]

export const MOTIONS: readonly Motion[] = ["still", "sliding", "rolling", "pocketed", "spinning"]

/** The keyframe of `b`'s state from time `t` on. */
export function toKeyframe(t: number, b: Ball): Keyframe {
  return [t, b.x, b.y, b.vx, b.vy, b.wx, b.wy, MOTIONS.indexOf(b.motion), b.wz]
}

/** The ball a keyframe describes. A keyframe doesn't say which pocket a pocketed ball is in. */
export function fromKeyframe(id: number, k: Keyframe): Ball {
  return { id, x: k[1], y: k[2], vx: k[3], vy: k[4], wx: k[5], wy: k[6], wz: k[8], motion: keyMotion(k), pocket: null }
}

/** When a keyframe's state starts (seconds into the track). */
export function keyTime(k: Keyframe): number {
  return k[0]
}

/** How the ball moves from a keyframe on. */
export function keyMotion(k: Keyframe): Motion {
  return MOTIONS[k[7]] ?? "still"
}

/** A contact, as the track carries it for the sound: [t, what, how hard (m/s)]. A jaw sounds as a cushion. */
export type Contact = [number, "ball" | "cushion" | "pocket", number]

/**
 * A whole run, as a table plays it back: each ball's states (`keys[id]`, the first one at t = 0, then one after each
 * change), and between two of them `evolve` says where the ball is (`sample` does it for every ball).
 */
export interface Track {
  /** Seconds until the last ball stops traveling. */
  duration: number
  keys: Keyframe[][]
  contacts: Contact[]
}

/** Something a ball touched during a run, at `t` seconds into it. */
export type ShotEvent =
  /** Two balls hit: `ball` has the lower id, and `speed` is how fast (m/s) one was moving against the other. */
  | { type: "ball"; t: number; ball: number; other: number; speed: number }
  /** A ball came off a cushion, or off a pocket's jaw: `speed` is how fast (m/s) it went into it. */
  | { type: "cushion"; t: number; ball: number; jaw: boolean; speed: number }
  /** A ball fell in `pocket` (an index in the table's `pockets`), moving at `speed` (m/s). */
  | { type: "pocket"; t: number; ball: number; pocket: number; speed: number }

export interface RunOptions {
  /** A run that hasn't settled after this many events stops where it is (`RunOutcome.settled` says so). */
  maxEvents?: number
}

export interface RunOutcome {
  /** Where every ball ended up, in the same order. */
  balls: Ball[]
  /** The whole run, to play back, at full precision (`compact` rounds it for the wire). */
  track: Track
  /** Every hit, bounce and fall, in order. */
  events: ShotEvent[]
  /** The balls that fell, in the order they fell. */
  pocketed: number[]
  /**
   * Whether it ran until nothing traveled. False when it reached `maxEvents` first: what still moved was stopped where
   * it was (it takes two balls locked together, and shouldn't happen).
   */
  settled: boolean
}

/** What a cue shot's rules ask of a run. */
export interface CueShot {
  /** The first ball the cue ball touched. */
  firstHit: number | null
  /** The balls that touched a cushion after the cue ball first touched a ball (the cue ball included), in order. */
  railsAfterHit: number[]
}

export interface ShotOutcome extends RunOutcome, CueShot {}

/**
 * The cue ball right after the cue strikes it toward (vx, vy), off center by `spin`: the spin is the hit's turn
 * around the ball's center (ω = 5 v d / 2R², d the tip's offset): a hit 0.4 R above the center, at 7/10 of its
 * height, makes it roll from the start.
 */
export function strike(table: BallsAndCloth, cue: Ball, vx: number, vy: number, spin?: Spin): Ball {
  const R = table.ballRadius
  const v = Math.hypot(vx, vy)
  const k = v > 0 ? (5 * TIP_REACH) / (2 * R) : 0
  const top = spin?.top ?? 0
  const side = spin?.side ?? 0
  // The tip's offset times the direction: up gives a spin around the axis to the shot's left, right one around the up.
  return settle(R, { ...cue, vx, vy, wx: -k * top * vy, wy: k * top * vx, wz: k * side * v })
}

/**
 * Runs the table from `start`, balls already moving, until nothing travels: every ball stopped or fell. `start` is the
 * whole table, each ball at its id's index, with its velocity and spin; each ball's `motion` is read from them (only
 * "pocketed" is taken as given). A ball still spinning in place once nothing else moves can't change anything, so the
 * run ends there and the ball is left still.
 */
export function run(table: TableSpec, start: readonly Ball[], options: RunOptions = {}): RunOutcome {
  const R = table.ballRadius
  const maxEvents = options.maxEvents ?? MAX_EVENTS
  const outs = outLines(table)
  // Past the ball's top or under the cloth, the cushion's nose would miss the ball, and a bounce would be NaN.
  if (!(table.cushionHeight >= 0 && table.cushionHeight <= 2 * R)) {
    throw new BilliardsError("bad_table", `cushionHeight ${table.cushionHeight} isn't from 0 to the ball's height`)
  }
  start.forEach((b, i) => {
    if (b.id !== i) throw new BilliardsError("ball_order", `ball ${b.id} is at index ${i}, not at its id's`)
  })
  let balls = start.map((b) => (b.motion === "pocketed" ? { ...b } : settle(R, b)))
  const keys: Keyframe[][] = balls.map((b) => [toKeyframe(0, b)])
  const events: ShotEvent[] = []
  const pocketed: number[] = []
  let time = 0

  for (let n = 0; n < maxEvents && balls.some(moving); n++) {
    const paths = balls.map((b) => path(table, b))
    const e = nextEvent(table, outs, balls, paths)
    if (!e) break
    time += e.dt
    balls = balls.map((b) => evolve(table, b, e.dt))
    const changed: number[] = []
    const b = balls[e.ball] as Ball
    if (e.type === "change") {
      balls[e.ball] = b.motion === "sliding" ? roll(R, b) : rest({ ...b, wz: b.motion === "spinning" ? 0 : b.wz })
      changed.push(e.ball)
    } else if (e.type === "ball") {
      const o = balls[e.other] as Ball
      const speed = Math.hypot(b.vx - o.vx, b.vy - o.vy)
      ;[balls[e.ball], balls[e.other]] = collide(table, b, o)
      changed.push(e.ball, e.other)
      events.push({ type: "ball", t: time, ball: e.ball, other: e.other, speed })
    } else if (e.type === "cushion" || e.type === "jaw") {
      let nx: number
      let ny: number
      if (e.type === "cushion") {
        nx = e.nx
        ny = e.ny
      } else {
        const jaw = table.jaws[e.jaw] as Point
        const d = Math.hypot(b.x - jaw.x, b.y - jaw.y)
        nx = (b.x - jaw.x) / d
        ny = (b.y - jaw.y) / d
      }
      events.push({
        type: "cushion",
        t: time,
        ball: e.ball,
        jaw: e.type === "jaw",
        speed: Math.abs(b.vx * nx + b.vy * ny),
      })
      balls[e.ball] = bounce(table, b, nx, ny)
      changed.push(e.ball)
    } else {
      events.push({ type: "pocket", t: time, ball: e.ball, pocket: e.pocket, speed: Math.hypot(b.vx, b.vy) })
      balls[e.ball] = { ...b, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, motion: "pocketed", pocket: e.pocket }
      pocketed.push(e.ball)
      changed.push(e.ball)
    }
    for (const id of changed) (keys[id] as Keyframe[]).push(toKeyframe(time, balls[id] as Ball))
  }

  const settled = !balls.some(moving)
  // What still spins in place stops, and so does whatever still moves past the event limit. The track keeps the spin
  // wearing away in place, which ends where the run does, but a ball stopped in its tracks needs a state saying so, or
  // the playback would carry it on.
  balls = balls.map((b, id) => {
    if (!moving(b) && b.motion !== "spinning") return b
    const stopped: Ball = { ...b, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, motion: "still" }
    if (moving(b)) (keys[id] as Keyframe[]).push(toKeyframe(time, stopped))
    return stopped
  })
  const contacts = events.map((e): Contact => [e.t, e.type, e.speed])
  return { balls, track: { duration: time, keys, contacts }, events, pocketed, settled }
}

/** What a cue shot's rules ask of a run's events, the cue ball being `cue`. */
export function cueShot(events: readonly ShotEvent[], cue = 0): CueShot {
  let firstHit: number | null = null
  const railsAfterHit: number[] = []
  for (const e of events) {
    if (e.type === "ball" && firstHit === null && (e.ball === cue || e.other === cue)) {
      firstHit = e.ball === cue ? e.other : e.ball
    } else if (e.type === "cushion" && firstHit !== null) railsAfterHit.push(e.ball)
  }
  return { firstHit, railsAfterHit }
}

/**
 * A cue shot: strikes the cue ball (id 0) toward velocity (vx, vy), in the center or off it by `spin`, and runs the
 * table until every ball stops or falls. `start` is the table, each ball at its id's index. It is `strike`, then `run`,
 * then `cueShot` on the run's events.
 */
export function simulate(
  table: TableSpec,
  start: readonly Ball[],
  vx: number,
  vy: number,
  spin?: Spin,
  options?: RunOptions,
): ShotOutcome {
  const cue = start[0]
  if (!cue || cue.id !== 0 || cue.motion === "pocketed") {
    throw new BilliardsError("no_cue_ball", "the cue ball (ball 0) isn't on the table")
  }
  const out = run(table, [strike(table, cue, vx, vy, spin), ...start.slice(1)], options)
  return { ...out, ...cueShot(out.events) }
}

const r3 = (v: number) => Math.round(v * 1e3) / 1e3
const r4 = (v: number) => Math.round(v * 1e4) / 1e4
const r5 = (v: number) => Math.round(v * 1e5) / 1e5

/**
 * `track` rounded, to keep a message small: times to a tenth of a millisecond, positions to a hundredth of a
 * millimeter, speeds to 0.1 mm/s, spins and a contact's strength to three decimals. The playback restarts from the
 * track's numbers at each change, so the rounding never adds up, and the balls land within 0.1 mm of where the run left
 * them.
 */
export function compact(track: Track): Track {
  return {
    duration: r4(track.duration),
    keys: track.keys.map((keys) =>
      keys.map((k): Keyframe => [r4(k[0]), r5(k[1]), r5(k[2]), r4(k[3]), r4(k[4]), r3(k[5]), r3(k[6]), k[7], r3(k[8])]),
    ),
    contacts: track.contacts.map(([t, what, speed]): Contact => [r4(t), what, r3(speed)]),
  }
}

/** Every ball at time `t` of a track, for the playback. A pocketed ball's `pocket` is null: the track doesn't carry it. */
export function sample(table: BallsAndCloth, track: Track, t: number): Ball[] {
  return track.keys.map((keys, id) => {
    let k = keys[0] as Keyframe
    for (const next of keys) {
      if (next[0] > t) break
      k = next
    }
    return evolve(table, fromKeyframe(id, k), t - k[0])
  })
}
