// Cue-sports physics as a library: a table as data (`table.ts`) and a shot run on it one event at a time
// (`physics.ts`). No dependencies, no randomness, no platform APIs: the same table, balls and shot give the same result
// every time. A game brings its own table sizes, its rack, its rules and how a player's input becomes a shot.
export * from "./table.ts"
export * from "./physics.ts"
