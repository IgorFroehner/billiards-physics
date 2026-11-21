import { describe, expect, it } from "vitest"
import { restingBall, simulate } from "./physics.ts"
import { poolBallsAndCloth, poolTable, POOL_BALL_RADIUS, sixPocketTable, type TableSpec } from "./table.ts"
import { rackedBalls, seeded } from "./testing.ts"

const SIZE = { width: 1, length: 2, cornerMouth: 0.08, sideMouth: 0.06, holeRadius: 0.058, jawRadius: 0.008 }

describe("a six-pocket table", () => {
  it("has pool's balls and cloth unless told otherwise", () => {
    expect(sixPocketTable(SIZE)).toMatchObject(poolBallsAndCloth())
    expect(sixPocketTable(SIZE).ballRadius).toBe(POOL_BALL_RADIUS)
  })

  it("takes one number of the balls and cloth and keeps the rest", () => {
    const fast = sixPocketTable(SIZE, { roll: 0.005 })
    expect(fast).toEqual({ ...sixPocketTable(SIZE), roll: 0.005 })
  })

  it("puts the cushion's nose where a smaller ball needs it, unless its height is given", () => {
    const snooker = sixPocketTable(SIZE, { ballRadius: 0.02625 })
    expect(snooker.cushionHeight).toBeCloseTo(0.635 * 2 * 0.02625, 12)
    expect(sixPocketTable(SIZE, { ballRadius: 0.02625, cushionHeight: 0.035 }).cushionHeight).toBe(0.035)
  })

  it("has six pockets, six cushions with a jaw at each end, and nothing of a game in it", () => {
    const table = sixPocketTable(SIZE)
    expect(table.pockets).toHaveLength(6)
    expect(table.cushions).toHaveLength(6)
    expect(table.jaws).toHaveLength(12)
    expect(Object.keys(table)).not.toContain("mouths")
  })
})

describe("the standard pool tables", () => {
  const tables: [7 | 8 | 9, number, number][] = [
    [7, 0.9906, 1.9812],
    [8, 1.1176, 2.2352],
    [9, 1.27, 2.54],
  ]

  it("are 39 by 78, 44 by 88 and 50 by 100 inches", () => {
    for (const [feet, width, length] of tables) {
      expect(poolTable(feet).width).toBeCloseTo(width, 9)
      expect(poolTable(feet).length).toBeCloseTo(length, 9)
    }
    expect(poolTable(9, { slide: 0.15 }).slide).toBe(0.15)
  })

  /** Ball 0 alone on the table, sent off at (vx, vy). */
  const send = (table: TableSpec, x: number, y: number, vx: number, vy: number) =>
    simulate(table, [restingBall(0, x, y)], vx, vy)

  it.each(tables)(
    "the %i-foot table takes a ball in a corner and in a side, and lets one pass a side pocket",
    (feet) => {
      const table = poolTable(feet)
      const { width: W, length: L, ballRadius: R } = table
      expect(send(table, 0.4, 0.4, -1, -1).balls[0]?.pocket).toBe(0)
      expect(send(table, W / 2, L / 2, 1, 0).balls[0]?.pocket).toBe(3)
      expect(send(table, W - 0.4, L - 0.4, 1, 1).balls[0]?.pocket).toBe(5)
      // Along the rail, a millimeter off the cushion, past the side pocket's far jaw.
      const along = send(table, R + 0.001, L / 2 - 0.3, 0, 0.6)
      expect(along.pocketed).toEqual([])
      expect(along.balls[0]?.y).toBeGreaterThan(L / 2 + 0.1)
    },
  )

  it.each(tables)("a break on the %i-foot table settles with every ball on the cloth or in a pocket", (feet) => {
    const table = poolTable(feet)
    const out = simulate(table, rackedBalls(table, seeded(feet)), 0.01, 7.5)
    expect(out.settled).toBe(true)
    expect(out.firstHit).toBe(1)
    for (const b of out.balls) {
      if (b.motion === "pocketed") continue
      expect(b.motion).toBe("still")
      expect(b.x).toBeGreaterThan(0)
      expect(b.x).toBeLessThan(table.width)
      expect(b.y).toBeGreaterThan(0)
      expect(b.y).toBeLessThan(table.length)
    }
  })
})
