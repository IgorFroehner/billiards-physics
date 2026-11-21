import { test } from "vitest"
import * as physics from "./physics.ts"
import type { Ball, Spin } from "./physics.ts"
import * as testing from "./testing.ts"

// How long the physics takes, on what a game asks of it: a break, a shot on a table with the balls spread out, and the
// playback's frames. `pnpm bench` runs it; `pnpm test` leaves it out.

// Read once: what a module exports is read through a getter each time, which would be timed too.
const { restingBall, sample, simulate } = physics
const { rackedBalls, seeded } = testing
const T = testing.TEST_TABLE

interface Shot {
  balls: Ball[]
  vx: number
  vy: number
  spin?: Spin
}

/** 16 balls anywhere on the table, none touching, and a shot in any direction at any spin. */
function spreadShot(next: () => number): Shot {
  const R = T.ballRadius
  const balls: Ball[] = []
  while (balls.length < 16) {
    const x = 2 * R + next() * (T.width - 4 * R)
    const y = 2 * R + next() * (T.length - 4 * R)
    if (balls.every((b) => Math.hypot(b.x - x, b.y - y) > 2.2 * R)) balls.push(restingBall(balls.length, x, y))
  }
  const angle = next() * 2 * Math.PI
  const v = 1 + next() * 4
  return { balls, vx: v * Math.cos(angle), vy: v * Math.sin(angle), spin: { side: next() - 0.5, top: next() - 0.5 } }
}

const breaks: Shot[] = Array.from({ length: 10 }, (_, s) => ({
  balls: rackedBalls(T, seeded(s)),
  vx: (0.05 * (s - 5)) / 5,
  vy: 7,
}))
const next = seeded(1000)
const spread: Shot[] = Array.from({ length: 30 }, () => spreadShot(next))
const play = (shots: readonly Shot[]) => {
  for (const s of shots) simulate(T, s.balls, s.vx, s.vy, s.spin)
}
const track = simulate(T, breaks[0]?.balls ?? [], 0, 7).track

test("the physics", async ({ bench }) => {
  await bench.compare(
    bench("10 breaks", () => play(breaks)),
    bench("30 shots on a spread table", () => play(spread)),
    bench("a second of a break's playback, at 60 frames", () => {
      for (let f = 0; f < 60; f++) sample(T, track, f / 60)
    }),
  )
})
