import { restingBall, type Ball } from "./physics.ts"
import { sixPocketTable, type TableSpec } from "./table.ts"

// What the tests share: a table, a rack to break and seeded luck. Not part of the library: the index leaves it out, and
// so does the build (`tsconfig.build.json`).

/** A 7-foot table with pool's 2¼-inch balls. */
export const TEST_TABLE: TableSpec = sixPocketTable({
  width: 0.9906,
  length: 1.9812,
  cornerMouth: 0.08,
  sideMouth: 0.06,
  holeRadius: 0.058,
  jawRadius: 0.008,
})

/** Numbers from 0 to 1 that only depend on the seed (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The cue ball on the head spot and 15 balls in a triangle, the apex on the foot spot, a hair apart (as a real rack
 * never sits perfectly), each ball at its id's index.
 */
export function rackedBalls(table: TableSpec, next: () => number): Ball[] {
  const R = table.ballRadius
  const gap = 0.004 * R
  const jitter = () => (next() * 2 - 1) * 0.001 * R
  const balls = [restingBall(0, table.headSpot.x, table.headSpot.y)]
  for (let row = 0; row < 5; row++) {
    for (let i = 0; i <= row; i++) {
      const x = table.footSpot.x + (i - row / 2) * (2 * R + gap) + jitter()
      const y = table.footSpot.y + row * Math.sqrt(3) * (R + gap / 2) + jitter()
      balls.push(restingBall(balls.length, x, y))
    }
  }
  return balls
}
