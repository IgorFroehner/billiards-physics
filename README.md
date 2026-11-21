# billiards-physics

Cue-sports physics in TypeScript: a table as data, and a shot run on it one event at a time. No dependencies, no randomness, no platform APIs, so it runs the same on a server, in a browser or in a test.

It is made for games where a server decides what a shot did: a table and a shot go in, and what comes out is where every ball ended up, what happened on the way, and a short track any screen can play back.

```ts
import { compact, poolTable, restingBall, sample, simulate } from "billiards-physics"

// A 9-foot pool table. Each ball sits at its id's index, the cue ball first.
const table = poolTable(9)
const balls = [restingBall(0, 0.6, 0.6), restingBall(1, 0.6, 1.5)]
// The cue ball sent along +y at 2 m/s, hit a little low and to the right.
const shot = simulate(table, balls, 0, 2, { side: 0.3, top: -0.5 })
shot.balls // where every ball ended up
shot.pocketed // the balls that fell, in order
shot.events // every hit, bounce and fall
shot.firstHit // the first ball the cue ball touched
sample(table, shot.track, 0.5) // every ball half a second in, to draw it
compact(shot.track) // the track rounded, to send over a network
```

## Install

```sh
npm install billiards-physics
```

It ships as ES modules with their type declarations, built to ES2022, and has no dependencies.

## Status

Until 1.0 the API can still change.

## What it models

- A ball slides, then rolls, then stops, on a parabola in time between two events, so a shot is a short list of states (`Track`) and nothing steps through time.
- The cue's hit point (`Spin`): follow, draw and side spin.
- Cushions by Han's model (2005): side spin bends the angle off a cushion.
- Friction between two balls: a cut or a side spin throws the ball hit, and spin passes from one to the other. `ballFriction: NO_BALL_FRICTION` on the table turns it off.
- A ball spinning in place, while the cloth wears its side spin away.
- Six pockets with rounded jaws.

## What it leaves out

No jumps or masse (the cue is level and nothing leaves the cloth), no squirt (the cue ball goes where it's aimed), and cushions are straight lines. A pocket is a circle a ball's center falls into and a jaw is a small circle at a cushion's end: neither has the shape of a real pocket.

## The same shot, the same result

Nothing in the library is random and nothing reads a clock: the same table, balls and shot give the same result every time, on the same JavaScript engine.

Across engines the last digit can differ, because the language doesn't pin down `Math.sin`, `Math.exp` or `Math.hypot` to the bit, and a shot with many hits can grow that into another shot. So don't run a shot on two machines and expect them to agree. Run it once, where the result counts, and send the track: a table that plays a track back only evaluates each ball's formula between two states, and lands every ball where the track says.

## How fast, how small

Measured on a laptop with Node 24: a 16-ball break takes about 2 ms once the code is warm (8 ms the first time), and an ordinary shot about 0.1 ms. The whole library is 4.5 kB minified and gzipped; a page that only plays tracks back needs under 1 kB of it.

## Conventions

- Units are SI: meters, seconds, m/s, rad/s.
- `x` runs across the table and `y` along it, from the head rail (`y = 0`, where the cue ball breaks from) to the foot rail (`y = length`). The playing surface is 0 to `width` by 0 to `length`, cushion nose to cushion nose.
- Spins follow the right-hand rule, with `z` up: a positive `wz` is counterclockwise seen from above, and a ball rolling along +y has a negative `wx`.
- A table's balls are a list where each ball sits at its id's index (`run` refuses another order). Ball 0 is the cue ball for `simulate`, which strikes it; `run` has no cue ball.
- Every ball on a table has the same radius and the same mass.
- A ball that fell stays in the list as `motion: "pocketed"`, with the `pocket` it's in.

## The table

A `TableSpec` is two halves in one object:

- its shape (`TableShape`): `width`, `length`, the `pockets` and their `holeRadius`, the `cushions`, their `jaws`, the head and foot spots;
- its balls and cloth (`BallsAndCloth`): `ballRadius`, the cloth's `slide`, `roll` and `spinning` friction, and what a hit does (`ballRestitution`, `ballFriction`, `cushionRestitution`, `cushionFriction`, `cushionHeight`).

| To get | Call |
| --- | --- |
| a standard pool table | `poolTable(7)`, `poolTable(8)`, `poolTable(9)` |
| a six-pocket table of your sizes | `sixPocketTable({ width, length, cornerMouth, sideMouth, holeRadius, jawRadius })` |
| other balls or cloth on either | a second argument with the numbers that change: `poolTable(9, { slide: 0.15 })` |
| any other table | a `TableSpec` written out: it's plain data |

The balls and cloth default to pool's (`poolBallsAndCloth()`), with pooltool's numbers.

## Running a shot

| Function | What it does |
| --- | --- |
| `simulate(table, balls, vx, vy, spin?)` | a cue shot: `strike` on ball 0, then `run`, then `cueShot` on the run's events |
| `strike(table, cue, vx, vy, spin?)` | the cue ball right after the cue hits it |
| `run(table, balls)` | the table from balls already moving until nothing travels: no cue needed |
| `cueShot(events, cue?)` | the first ball the cue ball hit and the balls that reached a cushion after it |
| `evolve(table, ball, dt)` | one ball `dt` seconds later, if nothing touches it |
| `collide(table, a, b)` | two balls right after they hit |
| `bounce(table, ball, nx, ny)` | a ball right after it comes off a cushion whose normal is (nx, ny) |
| `withMotion(table, ball)` | a hand-made ball with the motion its velocity and spin say |

`run` and `simulate` give back the `balls` at the end, the `track`, the `events`, the `pocketed` balls in order and `settled`. A run that goes past `maxEvents` (an option, 20,000 by default) stops where it is with `settled: false`. A mistake in the call throws a `BilliardsError` whose `code` says which: `no_cue_ball` or `ball_order`.

## The track

A `Track` is a run as a table plays it back: for each ball a list of keyframes (its state at t = 0 and after each change), the contacts for the sound, and the duration. `sample(table, track, t)` gives every ball at time `t`.

A `Keyframe` is a list of 9 numbers, compact because it's what a server sends:

| Index | What | Unit |
| --- | --- | --- |
| 0 | `t`, when the state starts | s |
| 1, 2 | `x`, `y` | m |
| 3, 4 | `vx`, `vy` | m/s |
| 5, 6 | `wx`, `wy` | rad/s |
| 7 | the motion, as an index in `MOTIONS` | |
| 8 | `wz`, the side spin | rad/s |

Read one with `keyTime`, `keyMotion` and `fromKeyframe(id, key)`, and write one with `toKeyframe(t, ball)`.

A track comes out at full precision. `compact(track)` rounds it for the wire (times to 0.1 ms, positions to 0.01 mm), which makes it less than half the size, and a table playing the rounded track still lands every ball within 0.1 mm of where the run left it.

## pooltool, and the names

This isn't a port of pooltool. It's a smaller thing that follows pooltool's models for how a ball moves on the cloth, how two balls hit and how a ball comes off a cushion (Han's 2005 model, one of the cushion models pooltool has), and leaves out what's listed above.

One difference is known. The friction between two balls can't pull harder than the friction times the hit's push. Here the push is the whole of it, (1 + e) / 2 of the closing speed; pooltool uses the speed the balls part at, e of it. At e = 0.95 the two are 2.6% apart, and only when the surfaces slip all through the hit.

Ours are plain words, pooltool's are the papers' symbols:

| Here | pooltool | |
| --- | --- | --- |
| `ballRadius` | `R` | |
| `slide` | `u_s` | sliding friction |
| `roll` | `u_r` | rolling friction |
| `spinning` | `u_sp_proportionality` | spinning friction over the radius: pooltool's `u_sp` is this times `R` |
| `ballRestitution` | `e_b` | |
| `ballFriction` (`a`, `b`, `c`) | `AlciatoreBallBallFriction` (`a`, `b`, `c`) | in place of a single `u_b` |
| `cushionRestitution` | `e_c` | |
| `cushionFriction` | `f_c` | |
| `cushionHeight` | the table's `cushion_height` | pooltool's default is 0.64 of the ball's height, ours 0.635 |
| `width`, `length` | `w`, `l` | |
| gravity, fixed at 9.81 | `g` | |
| not needed: the balls weigh the same | `m` | |
| a ball's `x`, `y` | `rvw[0]` | |
| `vx`, `vy` | `rvw[1]` | |
| `wx`, `wy`, `wz` | `rvw[2]` | |
| `motion` | `s` | |
| `"still"` | `stationary` | |
| `"sliding"`, `"rolling"`, `"spinning"`, `"pocketed"` | the same words | the numbers differ: `MOTIONS` is still, sliding, rolling, pocketed, spinning |
| `Spin.side` | the cue's `a` | `a = -side · TIP_REACH`: pooltool's `a` is positive to the left and a part of the whole radius |
| `Spin.top` | the cue's `b` | `b = top · TIP_REACH` |
| the cue ball's velocity (`vx`, `vy`) | the cue's `V0` and `phi` | `V0` is the stick's speed, not the ball's. `phi` in degrees turns the same way: 0 along +x, 90 along +y |

The two share their axes: `x` across, `y` from the head rail to the foot rail.

## Working on it

```sh
pnpm install
pnpm check    # tests, types, lint, formatting
pnpm build    # dist/, what the package ships
```

The source is `src/table.ts` (the table as data) and `src/physics.ts` (everything that moves). `src/testing.ts` is the tests' table and rack, and isn't part of the package.

## Credits

The method is Leckie and Greenspan's "An event-based pool physics simulator" (2006). The motion models, the friction between balls and the default cloth and ball numbers follow [pooltool](https://github.com/ekiefl/pooltool) by Evan Kiefl (Apache-2.0). The cushions are from Han, "Dynamics in carom and three cushion billiards" (2005). The ball friction's fit is from David Alciatore's technical proofs (TP A-14).

It started as the physics of a pool table on a site of casual multiplayer games, where a server runs each shot and every phone plays it back.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
