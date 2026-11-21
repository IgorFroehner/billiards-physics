import { describe, expect, it } from "vitest"
import {
  BilliardsError,
  bounce,
  collide,
  compact,
  cueShot,
  evolve as evolveOn,
  fromKeyframe,
  keyMotion,
  restingBall as ball,
  keyTime,
  run as runOn,
  sample as sampleOn,
  simulate as simulateOn,
  strike,
  toKeyframe,
  withMotion,
  type Ball,
  type Keyframe,
  type RunOptions,
  type Spin,
  type Track,
} from "./physics.ts"
import { NO_BALL_FRICTION, type TableSpec } from "./table.ts"
import { rackedBalls, seeded, TEST_TABLE as T } from "./testing.ts"

const { ballRadius: R, length: L, width: W, pockets: POCKETS, holeRadius: HOLE_RADIUS } = T
const E_BALL = T.ballRestitution
const MU_ROLL = T.roll
const G = 9.81
/** As hard as a break goes (m/s). */
const HARDEST = 7.5
const MU_SLIDE = T.slide
const simulate = (balls: readonly Ball[], vx: number, vy: number, spin?: Spin, options?: RunOptions) =>
  simulateOn(T, balls, vx, vy, spin, options)
const run = (balls: readonly Ball[], options?: RunOptions) => runOn(T, balls, options)
const evolve = (b: Ball, dt: number) => evolveOn(T, b, dt)
const sample = (track: Track, t: number) => sampleOn(T, track, t)

/** A table with only these balls on it, the rest already pocketed, each at its id's index. */
function table(...on: Ball[]): Ball[] {
  return Array.from({ length: 16 }, (_, id) => on.find((b) => b.id === id) ?? { ...ball(id, 0, 0), motion: "pocketed" })
}

/** Every rule a settled table keeps: nothing moving, nothing overlapping, nothing in a hole or off the table. */
function expectSettled(balls: readonly Ball[]) {
  const on = balls.filter((b) => b.motion !== "pocketed")
  for (const b of on) {
    expect(b.motion).toBe("still")
    expect(b.x).toBeGreaterThan(-0.04)
    expect(b.x).toBeLessThan(W + 0.04)
    expect(b.y).toBeGreaterThan(-0.04)
    expect(b.y).toBeLessThan(L + 0.04)
    for (const h of POCKETS) expect(Math.hypot(b.x - h.x, b.y - h.y)).toBeGreaterThanOrEqual(HOLE_RADIUS - 1e-9)
  }
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      const a = on[i] as Ball
      const b = on[j] as Ball
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(2 * R - 1e-7)
    }
  }
}

describe("a ball on the cloth", () => {
  it("slides, then rolls at 5/7 of its speed, after 2v/(7 μ g)", () => {
    const v0 = 2
    const out = simulate(table(ball(0, W / 2, 0.3)), 0, v0)
    const keys = out.track.keys[0] ?? []
    expect(keys[1]?.[0]).toBeCloseTo((2 * v0) / (7 * MU_SLIDE * G), 3)
    expect(keys[1]?.[4]).toBeCloseTo((5 / 7) * v0, 3)
    expect(keys[1]?.[7]).toBe(2) // rolling
  })

  it("rolls v²/(2 μ g) before it stops", () => {
    const v = 0.5
    const rolling = { ...ball(0, W / 2, 0.2), vy: v, wx: -v / R, motion: "rolling" as const }
    const end = evolve(rolling, 100)
    expect(end.y - 0.2).toBeCloseTo((v * v) / (2 * MU_ROLL * G), 6)
    expect(end.vy).toBeCloseTo(0, 9)
  })

  it("comes straight back off a cushion hit square, at about four fifths of the speed", () => {
    const [into, off] = offTheFootRail(simulate(table(ball(0, W / 2, L - 0.3)), 0, 1))
    // Han's model for a rolling ball: the nose above the center takes a little more than the restitution alone.
    expect(-off.vy / into.vy).toBeGreaterThan(0.75)
    expect(-off.vy / into.vy).toBeLessThan(0.85)
    expect(off.vx).toBeCloseTo(0, 9)
  })
})

/** The cue ball just before and just after it first comes back off the foot rail. */
function offTheFootRail(out: ReturnType<typeof simulate>): [Ball, Ball] {
  const keys = out.track.keys[0] ?? []
  const at = keys.findIndex((k) => k[4] < 0)
  const before = keys[at - 1]
  const hit = keys[at]
  if (!before || !hit) throw new Error("the ball never came back off the foot rail")
  return [evolve(fromKeyframe(0, before), hit[0] - before[0]), fromKeyframe(0, hit)]
}

describe("spin from the cue", () => {
  /** The cue ball's velocity along y once it rolls again after hitting a ball straight ahead, 0.3 m away. */
  function after(top: number): number {
    const out = simulate(table(ball(0, W / 2, 0.5), ball(1, W / 2, 0.8)), 0, 2, { side: 0, top })
    const keys = out.track.keys[0] ?? []
    const hit = keys.findIndex((k) => k[0] === out.track.contacts[0]?.[0])
    return keys[hit + 1]?.[4] ?? NaN
  }

  it("high follows the ball it hits, low draws back, the center only creeps on", () => {
    // In the center the cue ball has started to roll by the hit, so it follows a little.
    expect(after(1)).toBeGreaterThan(0.5)
    expect(after(0)).toBeGreaterThan(0)
    expect(after(0)).toBeLessThan(0.3)
    expect(after(-1)).toBeLessThan(-0.3)
  })

  it("a hit at 7/10 of the ball's height rolls from the start", () => {
    const out = simulate(table(ball(0, W / 2, 0.5)), 0, 1, { side: 0, top: 0.8 })
    expect(out.track.keys[0]?.[0]?.[7]).toBe(2) // rolling
  })

  it("side spin bends the angle off a cushion: right goes right, left goes left, as much", () => {
    const shoot = (side: number) =>
      offTheFootRail(simulate(table(ball(0, W / 2, L - 0.4)), 0, 1.5, { side, top: 0 }))[1]
    const right = shoot(1)
    const left = shoot(-1)
    expect(right.vx).toBeGreaterThan(0.05)
    expect(left.vx).toBeCloseTo(-right.vx, 9)
    expect(shoot(0).vx).toBeCloseTo(0, 9)
  })

  it("side spin wears away on the cloth, and a ball that stops drops it", () => {
    const out = simulate(table(ball(0, W / 2, 0.3)), 0, 0.5, { side: 1, top: 0 })
    expect(out.track.keys[0]?.[0]?.[8]).toBeGreaterThan(0)
    expect(out.balls[0]?.wz).toBe(0)
    const spinning = { ...ball(0, W / 2, 0.2), vy: 2, wx: -2 / R, wz: 10, motion: "rolling" as const }
    expect(evolve(spinning, 0.5).wz).toBeCloseTo(10 - 0.5 * ((5 * T.spinning * G) / 2), 9)
  })
})

describe("two balls", () => {
  it("head on, the cue ball gives the other almost all its speed", () => {
    const out = simulate(table(ball(0, W / 2, 0.5), ball(1, W / 2, 0.5 + 4 * R)), 0, 1)
    expect(out.firstHit).toBe(1)
    const [, , , , cueAfter] = out.track.keys[0]?.[1] ?? []
    const [, , , , objectAfter] = out.track.keys[1]?.[1] ?? []
    const total = (cueAfter ?? 0) + (objectAfter ?? 0)
    expect((objectAfter ?? 0) / total).toBeCloseTo((1 + E_BALL) / 2, 3)
  })

  it("tells which balls reached a cushion after the first hit", () => {
    const out = simulate(table(ball(0, W / 2, 0.5), ball(1, W / 2, 0.5 + 4 * R)), 0, 2)
    expect(out.firstHit).toBe(1)
    expect(out.railsAfterHit[0]).toBe(1)
  })

  it("never pass through each other, even at the hardest speed", () => {
    const out = simulate(table(ball(0, W / 2, 0.3), ball(1, W / 2 + R, L - 0.3)), 0, HARDEST)
    expect(out.firstHit).toBe(1)
    expectSettled(out.balls)
  })
})

describe("the friction between two balls", () => {
  const SMOOTH: TableSpec = { ...T, ballFriction: NO_BALL_FRICTION }
  const deg = (rad: number) => (rad * 180) / Math.PI

  /**
   * The cue ball sent along +y, from two balls away, into a ball it cuts to the right by `cut` (rad): both balls right
   * after the hit, and the hit's line (the direction from the cue ball's center to the other's).
   */
  function cutShot(on: TableSpec, cut: number, speed: number, spin?: Spin) {
    const cue = ball(0, W / 2, 0.5)
    const line = { x: Math.sin(cut), y: Math.cos(cut) }
    const object = ball(1, cue.x + 2 * R * line.x, cue.y + 4 * R + 2 * R * line.y)
    const out = simulateOn(on, table(cue, object), 0, speed, spin)
    const hit = out.track.contacts[0]?.[0] ?? NaN
    const after = (id: number) => {
      const key = (out.track.keys[id] ?? []).find((k) => k[0] === hit)
      if (!key) throw new Error(`ball ${id} wasn't in the first hit`)
      return fromKeyframe(id, key)
    }
    const keys = out.track.keys[0] ?? []
    const before = keys[keys.findIndex((k) => k[0] === hit) - 1]
    if (!before) throw new Error("the cue ball has no state before the hit")
    return { cue: after(0), object: after(1), line, into: evolveOn(on, fromKeyframe(0, before), hit - before[0]) }
  }

  /** How far (rad) the ball hit leaves the hit's line, toward the way the cue ball was going. */
  function thrown(shot: ReturnType<typeof cutShot>): number {
    return Math.atan2(shot.line.x, shot.line.y) - Math.atan2(shot.object.vx, shot.object.vy)
  }

  it("without it, the ball hit leaves along the line between the centers", () => {
    expect(deg(thrown(cutShot(SMOOTH, Math.PI / 6, 1)))).toBeCloseTo(0, 1)
    expect(cutShot(SMOOTH, Math.PI / 6, 1, { side: 1, top: 0 }).object.wz).toBe(0)
  })

  it("a cut throws the ball hit toward the way the cue ball was going, more when slow than when fast", () => {
    const slow = deg(thrown(cutShot(T, Math.PI / 4, 0.6)))
    const fast = deg(thrown(cutShot(T, Math.PI / 4, 5)))
    expect(slow).toBeGreaterThan(2)
    expect(slow).toBeLessThan(7)
    expect(fast).toBeGreaterThan(0.2)
    expect(fast).toBeLessThan(slow / 2)
  })

  it("side spin throws a ball hit straight on to the other side, and turns it the other way", () => {
    const right = cutShot(T, 0, 1, { side: 1, top: 0 })
    const left = cutShot(T, 0, 1, { side: -1, top: 0 })
    expect(right.object.vx).toBeLessThan(-0.005)
    expect(right.object.wz).toBeLessThan(-0.5)
    expect(left.object.vx).toBeCloseTo(-right.object.vx, 3)
    expect(left.object.wz).toBeCloseTo(-right.object.wz, 2)
    expect(cutShot(T, 0, 1).object.vx).toBeCloseTo(0, 6)
  })

  it("only moves speed from one ball to the other", () => {
    for (const cut of [0.2, 0.6, 1]) {
      for (const spin of [undefined, { side: 1, top: 0 }, { side: -0.6, top: 0.6 }]) {
        const { cue, object, into } = cutShot(T, cut, 2, spin)
        expect(cue.vx + object.vx).toBeCloseTo(into.vx, 3)
        expect(cue.vy + object.vy).toBeCloseTo(into.vy, 3)
      }
    }
  })

  it("never pulls harder than what stops the two surfaces slipping", () => {
    // How fast the cue ball's surface passes the other's where they touch, along the cloth, across the hit's line.
    const slip = (shot: ReturnType<typeof cutShot>, cue: Ball, object: Ball) => {
      const across = { x: -shot.line.y, y: shot.line.x }
      return (cue.vx - object.vx) * across.x + (cue.vy - object.vy) * across.y + R * (cue.wz + object.wz)
    }
    // A thin slow cut grips: the slip ends at zero, not turned around. A fast one slips all through.
    const grip = cutShot(T, 0.05, 0.4)
    expect(slip(grip, grip.into, ball(1, 0, 0))).toBeGreaterThan(0.01)
    expect(slip(grip, grip.cue, grip.object)).toBeCloseTo(0, 2)
    const slide = cutShot(T, Math.PI / 4, 4)
    expect(slip(slide, slide.cue, slide.object)).toBeGreaterThan(1)
    expect(slip(slide, slide.cue, slide.object)).toBeLessThan(slip(slide, slide.into, ball(1, 0, 0)))
  })

  it("a rolling cue ball gives the ball it hits a little spin the other way", () => {
    const out = simulate(table(ball(0, W / 2, 0.3), ball(1, W / 2, 1)), 0, 1.5)
    const hit = out.track.contacts[0]?.[0]
    const object = (out.track.keys[1] ?? []).find((k) => k[0] === hit)
    // Rolling along +y is a negative spin around x: the ball hit starts with a positive one.
    expect(object?.[5]).toBeGreaterThan(0.5)
  })
})

describe("a ball spinning in place", () => {
  /** The cue ball, with side spin, stops dead behind a ball it sends into the side pocket. */
  const stopShot = () =>
    simulate(table(ball(0, W - 0.15 - 4 * R, L / 2), ball(1, W - 0.15, L / 2)), 1, 0, { side: 1, top: 0 })

  it("keeps its side spin after it stops, and the shot doesn't wait for it", () => {
    const out = stopShot()
    expect(out.pocketed).toEqual([1])
    const spinning = (out.track.keys[0] ?? []).find((k) => k[7] === 4)
    expect(spinning?.[8]).toBeGreaterThan(20)
    // The spin would take seconds to run out.
    expect(out.track.duration).toBeLessThan(((spinning?.[8] ?? 0) / ((5 * T.spinning * G) / 2)) * 0.5)
    expect(out.balls[0]).toMatchObject({ motion: "still", wz: 0, vx: 0, vy: 0 })
  })

  it("plays back spinning less and less, in the same place", () => {
    const out = stopShot()
    const key = (out.track.keys[0] ?? []).find((k) => k[7] === 4)
    if (!key) throw new Error("the cue ball never spun in place")
    const early = sample(out.track, key[0] + 0.01)[0] as Ball
    const late = sample(out.track, key[0] + 0.2)[0] as Ball
    expect(early.motion).toBe("spinning")
    expect(late.wz).toBeCloseTo(early.wz - 0.19 * ((5 * T.spinning * G) / 2), 2)
    expect([late.x, late.y]).toEqual([early.x, early.y])
  })

  it("throws the ball that hits it", () => {
    const spinning: Ball = { ...ball(1, W / 2, 0.8), wz: 60, motion: "spinning" }
    const out = simulate(table(ball(0, W / 2, 0.5), spinning), 0, 1)
    const hit = out.track.contacts[0]?.[0]
    const cue = (out.track.keys[0] ?? []).find((k) => k[0] === hit)
    const object = (out.track.keys[1] ?? []).find((k) => k[0] === hit)
    expect(cue?.[3]).toBeGreaterThan(0.005)
    expect(object?.[3]).toBeLessThan(-0.005)
  })
})

describe("pockets", () => {
  it("a ball sent at a corner falls in it", () => {
    const out = simulate(table(ball(0, 0.4, 0.4)), -1, -1)
    expect(out.pocketed).toEqual([0])
    expect(out.balls[0]?.pocket).toBe(0)
  })

  it("a ball sent straight at a side pocket falls in it", () => {
    const out = simulate(table(ball(0, W / 2, L / 2)), 1, 0)
    expect(out.balls[0]?.pocket).toBe(3)
  })

  it("a ball sent along the rail past a side pocket's jaw stays on the table", () => {
    const out = simulate(table(ball(0, R + 0.001, 0.3)), 0, 0.6)
    expect(out.pocketed).toEqual([])
    expectSettled(out.balls)
  })
})

describe("the break and the shots after it", () => {
  it("leaves every table settled, whatever the shot", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const next = seeded(seed * 31)
      let balls = rackedBalls(T, seeded(seed))
      for (let n = 0; n < 8 && balls[0]?.motion !== "pocketed"; n++) {
        const angle = n === 0 ? Math.PI / 2 + (next() - 0.5) * 0.02 : next() * 2 * Math.PI
        const v = n === 0 ? HARDEST : 0.25 + (HARDEST - 0.25) * next() ** 2
        // Any spin, inside the circle the tip may hit.
        const r = Math.sqrt(next())
        const turn = next() * 2 * Math.PI
        const spin = { side: r * Math.cos(turn), top: r * Math.sin(turn) }
        const out = simulate(balls, v * Math.cos(angle), v * Math.sin(angle), spin)
        expectSettled(out.balls)
        expect(out.track.duration).toBeLessThan(30)
        balls = out.balls
      }
    }
  })

  it("plays back to where the server left every ball", () => {
    const balls = rackedBalls(T, seeded(3))
    const out = simulate(balls, 0.02, HARDEST)
    const end = sample(out.track, out.track.duration + 1)
    end.forEach((b, i) => {
      const real = out.balls[i] as Ball
      expect(Math.hypot(b.x - real.x, b.y - real.y)).toBeLessThan(1e-4)
    })
  })

  it("is the same every time", () => {
    const balls = rackedBalls(T, seeded(5))
    expect(simulate(balls, 0.01, 6)).toEqual(simulate(balls, 0.01, 6))
  })

  // Every number of one break, to the last digit: a change meant only to tidy or speed up the code keeps them all, and
  // one that changes the physics, however little, shows here. This break has a bit of everything: balls, cushions,
  // jaws, a pocket, and all five motions. When a change is meant to move the numbers, `pnpm vitest run -u` writes the
  // new ones.
  it("keeps its numbers from one version to the next", () => {
    const out = simulate(rackedBalls(T, seeded(8)), 0.02, HARDEST, { side: 0.2, top: 0.3 })
    expect({
      duration: out.track.duration,
      events: out.events.length,
      keyframes: out.track.keys.flat().length,
      pocketed: out.pocketed,
      balls: out.balls.map((b) => (b.motion === "pocketed" ? `pocket ${b.pocket}` : `${b.x}, ${b.y}`)),
    }).toMatchInlineSnapshot(`
      {
        "balls": [
          "0.9566105679442347, 1.9027356491829126",
          "pocket 0",
          "0.45354039109927535, 1.5445033534325139",
          "0.6166988876783738, 1.5318735816649713",
          "0.40516044408125423, 1.6007260499841804",
          "0.49604250675442757, 1.588001751017505",
          "0.7292775097930888, 1.5500540503318678",
          "0.3652947623335332, 1.657777502343242",
          "0.4700346258377292, 1.642258945520298",
          "0.5524391058824346, 1.683739993385355",
          "0.8491255615081997, 1.8864422514001302",
          "0.22118805776988856, 0.8509408812289628",
          "0.34629621734778393, 1.7385413696316134",
          "0.42737859966712083, 1.9171191869456887",
          "0.5628027295072444, 1.7897579721121588",
          "0.9113929623665195, 0.729632170680049",
        ],
        "duration": 7.162998268055041,
        "events": 44,
        "keyframes": 138,
        "pocketed": [
          1,
        ],
      }
    `)
  })
})

describe("a run without a cue", () => {
  /** Rolling along the table at `vy`. */
  const rolling = (id: number, x: number, y: number, vy: number): Ball => ({ ...ball(id, x, y), vy, wx: -vy / R })

  it("after a strike, is the shot", () => {
    const balls = rackedBalls(T, seeded(7))
    const spin = { side: 0.4, top: -0.3 }
    const ran = run([strike(T, balls[0] as Ball, 0.03, 6, spin), ...balls.slice(1)])
    expect({ ...ran, ...cueShot(ran.events) }).toEqual(simulate(balls, 0.03, 6, spin))
  })

  it("takes balls already moving, with no cue ball among them", () => {
    const out = run([rolling(0, W / 2, 0.5, 1), rolling(1, W / 2, 1, -1)])
    const [hit] = out.events
    expect(hit).toMatchObject({ type: "ball", ball: 0, other: 1 })
    // Each has rolled a little slower by the time they meet.
    expect(hit?.speed).toBeGreaterThan(1.9)
    expect(hit?.speed).toBeLessThan(2)
    // The same ball from both sides: they come apart as they came together.
    const after = (id: number) => (out.track.keys[id] ?? []).find((k) => keyTime(k) === hit?.t)
    expect(after(0)?.[4]).toBeCloseTo(-(after(1)?.[4] ?? NaN), 9)
    expect(out.settled).toBe(true)
    expectSettled(out.balls)
  })

  it("reads each ball's motion from its velocity and spin", () => {
    const out = run([
      { ...ball(0, 0.2, 0.3), vy: 1 },
      rolling(1, 0.4, 0.3, 1),
      { ...ball(2, 0.6, 0.3), wz: 30 },
      ball(3, 0.8, 0.3),
      { ...ball(4, 0, 0), vy: 1, motion: "pocketed" },
    ])
    expect(out.track.keys.map((keys) => keyMotion(keys[0] as Keyframe))).toEqual([
      "sliding",
      "rolling",
      "spinning",
      "still",
      "pocketed",
    ])
    expect(withMotion(T, { ...ball(0, 0.2, 0.3), vy: 1 }).motion).toBe("sliding")
    expect(withMotion(T, rolling(1, 0.4, 0.3, 1)).motion).toBe("rolling")
  })

  it("tells a ball out of its place from a missing cue ball, and from a table its cushions can't play on", () => {
    const code = (go: () => unknown) => {
      try {
        go()
      } catch (e) {
        return e instanceof BilliardsError ? e.code : e
      }
      return null
    }
    expect(code(() => run([ball(1, 0.3, 0.3)]))).toBe("ball_order")
    expect(code(() => simulate([{ ...ball(0, 0, 0), motion: "pocketed" }], 0, 1))).toBe("no_cue_ball")
    expect(code(() => simulate([], 0, 1))).toBe("no_cue_ball")
    expect(code(() => run([]))).toBeNull()
    const low = { ...T, cushionHeight: -0.001 }
    const high = { ...T, cushionHeight: 2 * R + 0.001 }
    expect(code(() => runOn(low, [ball(0, 0.3, 0.3)]))).toBe("bad_table")
    expect(code(() => simulateOn(high, [ball(0, 0.3, 0.3)], 0, 1))).toBe("bad_table")
  })

  it("stops at the event limit, and says it didn't settle", () => {
    const balls = rackedBalls(T, seeded(2))
    const cut = simulate(balls, 0, HARDEST, undefined, { maxEvents: 40 })
    expect(cut.settled).toBe(false)
    expect(cut.balls.every((b) => b.motion === "still" || b.motion === "pocketed")).toBe(true)
    // The track stops them where the run did.
    sample(cut.track, cut.track.duration + 1).forEach((b, i) => {
      const real = cut.balls[i] as Ball
      expect(Math.hypot(b.x - real.x, b.y - real.y)).toBeLessThan(1e-9)
    })
    const whole = simulate(balls, 0, HARDEST)
    expect(whole.settled).toBe(true)
    expect(whole.track.duration).toBeGreaterThan(cut.track.duration)
  })
})

describe("the events of a run", () => {
  it("are every hit, bounce and fall in order, and the track's contacts", () => {
    // The cue ball sends ball 1 into the side pocket.
    const out = simulate(table(ball(0, W - 0.15 - 4 * R, L / 2), ball(1, W - 0.15, L / 2)), 1, 0)
    expect(out.events.map((e) => e.type)).toEqual(["ball", "pocket"])
    expect(out.events[1]).toMatchObject({ ball: 1, pocket: 3 })
    expect(out.track.contacts).toEqual(out.events.map((e) => [e.t, e.type, e.speed]))
    expect(out.events.every((e, i) => e.t >= (out.events[i - 1]?.t ?? 0))).toBe(true)
  })

  it("give the first ball hit and the rails after it, whichever ball is the cue ball", () => {
    const out = simulate(table(ball(0, W / 2, 0.5), ball(1, W / 2, 0.5 + 4 * R)), 0, 2)
    expect(cueShot(out.events)).toEqual({ firstHit: out.firstHit, railsAfterHit: out.railsAfterHit })
    expect(cueShot(out.events, 1).firstHit).toBe(0)
    expect(cueShot(out.events, 2)).toEqual({ firstHit: null, railsAfterHit: [] })
    const rail = out.events.find((e) => e.type === "cushion")
    expect(rail).toMatchObject({ ball: 1, jaw: false })
  })
})

describe("the single hits", () => {
  it("collide: head on and without spin, the balls trade their speed, less what the hit loses", () => {
    const [a, b] = collide(T, withMotion(T, { ...ball(0, 0.5, 0.5), vy: 1 }), ball(1, 0.5, 0.5 + 2 * R))
    expect(a.vy).toBeCloseTo((1 - E_BALL) / 2, 12)
    expect(b.vy).toBeCloseTo((1 + E_BALL) / 2, 12)
    expect([a.vx, b.vx]).toEqual([0, 0])
    expect(b.motion).toBe("sliding")
  })

  it("collide: a cut throws the ball hit, and not on a table without ball friction", () => {
    const cut = Math.PI / 4
    const into = withMotion(T, { ...ball(0, 0.5, 0.5), vy: 1 })
    const object = ball(1, 0.5 + 2 * R * Math.sin(cut), 0.5 + 2 * R * Math.cos(cut))
    const [, smooth] = collide({ ...T, ballFriction: NO_BALL_FRICTION }, into, object)
    expect(Math.atan2(smooth.vx, smooth.vy)).toBeCloseTo(cut, 12)
    const [, thrown] = collide(T, into, object)
    expect(Math.atan2(thrown.vx, thrown.vy)).toBeLessThan(cut - 0.01)
  })

  it("bounce: off the foot rail, straight back without spin and to a side with it", () => {
    const into = withMotion(T, { ...ball(0, 0.5, L - R), vy: 1 })
    const off = bounce(T, into, 0, -1)
    expect(off.vy).toBeLessThan(-0.5)
    expect(off.vx).toBeCloseTo(0, 12)
    const right = bounce(T, { ...into, wz: 40 }, 0, -1)
    const left = bounce(T, { ...into, wz: -40 }, 0, -1)
    expect(Math.abs(right.vx)).toBeGreaterThan(0.05)
    expect(left.vx).toBeCloseTo(-right.vx, 12)
  })

  it("bounce: a ball already leaving only keeps leaving", () => {
    const leaving = withMotion(T, { ...ball(0, 0.5, L - R), vx: 0.3, vy: -1 })
    expect(bounce(T, leaving, 0, -1)).toMatchObject({ vx: 0.3, vy: -1 })
  })
})

describe("a keyframe", () => {
  it("is read by name, and written back the same", () => {
    const b: Ball = {
      id: 3,
      x: 0.4,
      y: 1.2,
      vx: 0.5,
      vy: -0.25,
      wx: 7,
      wy: 11,
      wz: -13,
      motion: "sliding",
      pocket: null,
    }
    const key = toKeyframe(2.5, b)
    expect(keyTime(key)).toBe(2.5)
    expect(keyMotion(key)).toBe("sliding")
    expect(fromKeyframe(3, key)).toEqual(b)
  })

  it("is rounded only by compact, and still plays back to where the run left every ball", () => {
    const out = simulate(rackedBalls(T, seeded(3)), 0.02, HARDEST)
    const small = compact(out.track)
    const decimals = (v: number, n: number) => Math.abs(v * 10 ** n - Math.round(v * 10 ** n)) < 1e-6
    const numbers = (track: Track) => track.keys.flat().flatMap((k) => [k[0], k[1], k[2]])
    expect(numbers(small).every((v) => decimals(v, 5))).toBe(true)
    expect(numbers(out.track).every((v) => decimals(v, 5))).toBe(false)
    expect(compact(small)).toEqual(small)
    expect(small.keys.map((keys) => keys.length)).toEqual(out.track.keys.map((keys) => keys.length))
    expect(JSON.stringify(small).length).toBeLessThan(JSON.stringify(out.track).length / 2)
    sample(small, small.duration + 1).forEach((b, i) => {
      const real = out.balls[i] as Ball
      expect(Math.hypot(b.x - real.x, b.y - real.y)).toBeLessThan(1e-4)
    })
  })
})
