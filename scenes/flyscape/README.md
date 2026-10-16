# Fly world

A desk at dusk: a lit window, a stack of books, a mug, and four fruit flies that walk,
groom, take off, fly between the furniture and come down for sugar. The wallpaper menu's
**Feed** drops four cubes of sugar; a click in the browser preview drops one where it
landed.

## What is real, and what is not (yet)

The flies are procedural, and their behaviour is scripted in the same sense the other
worlds' fish are: a small state machine, tuned by hand. What makes this world different
is the seam it is built around — `src/brain.js`.

Today `createBrain()` is a **scripted placeholder**: a loom pulse for a fast cursor, a
slow arousal wave and hunger, and no connectome involved. The plan is to replace it with
the real thing behind the same `update`/`notify` contract: a leaky integrate-and-fire
simulation of the FlyWire (or MaleCNS) connectome driving `escape` (LC4/LPLC2 → DNp01),
`steer` (LC10a → DNa01/DNa02) and feeding (sugar GRNs → proboscis motor neurons). The
body, the world and the tests do not change when that happens — only `brain.js` does.

The candidates for that engine, and the reasons they were shortlisted, are recorded in
the research notes that seeded this scene (see [awesome-fly](https://github.com/cobanov/awesome-fly)
for the wider ecosystem of fly-connectome projects).

## Files

- `src/main.js` — the scene bootstrap: renderer, lights, pointer-as-loom, feeding,
  the fixed-step loop, and the bridge that feeds the brain seam one record per fly.
- `src/brain.js` — the seam. Placeholder circuit today; the connectome engine's home.
- `src/fly.js` — the procedural fly body and its behaviour machine.
- `src/environment.js` — the room: desk, wall, window light, books, mug, dust motes.
- `src/food.js` — sugar cubes: falling, resting, shrinking under a bite, dissolving.
- `src/render-policy.js` — shadow and resolution budgets for the quality profiles.
- `tests/behavior.mjs` — headless checks: the brain contract, loom pulses and cooldown,
  a slow approach, ninety seconds of desk life, determinism, startle and settle,
  feeding, sugar dissolve, and the presentation caps. Run with
  `node scenes/flyscape/tests/behavior.mjs`.

## Data licences, for when the connectome lands

- FlyWire (FAFB) data is released under **CC BY-NC 4.0**: attribution, non-commercial.
- MaleCNS v1.0 is released under **CC BY 4.0**, and covers the brain *and* ventral nerve
  cord, including the leg motor neurons a walking fly needs. If this world ever ships,
  prefer MaleCNS-derived packs, or fetch FlyWire data at first run with clear attribution
  rather than bundling it.
