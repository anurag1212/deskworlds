# Fly world

A desk at dusk: a lit window, a stack of books, a mug, and four fruit flies that walk,
groom, take off, fly between the furniture and come down for sugar. The wallpaper menu's
**Feed** drops four cubes of sugar; a click in the browser preview drops one where it
landed.

## What is real, and what is not (yet)

The flies are procedural, and their bodies are a hand-built state machine in the
same sense the other worlds' fish are. What makes this world different is what
decides: `src/connectome.js` runs a leaky integrate-and-fire simulation of the
real FlyWire v783 reduced circuit (961 neurons, 17,952 signed synapses, Shiu et
al. 2024 constants at 0.1 ms steps), one independent circuit per fly.

- **Escape** fires on the LC4/LPLC2 looming-detector burst (smoothed over
  150 ms; a fast loom bursts ~150 Hz per cell, a slow hand ~5). The reduced
  extract cuts the recurrent loops that fire the giant fiber in the full brain
  — GF's in-circuit in-weight sums net negative — so a GF spike also escapes
  but the burst is the working signal. Stated, not hidden.
- **Steering** reads DNa01/DNa02 right-minus-left through real wiring that
  segregates perfectly (right-eye drive reaches right DNs only, and vice
  versa), minus a calibration offset measured at the background operating
  point. Symmetric background drive means straight walking until food biases it.
- **Feeding** runs the Shiu headline circuit: sugar GRNs at 100 Hz drive the
  proboscis motor neurons (4.3 Hz over a silent baseline).
- **Restlessness** comes from the brain's own sparse background activity, not a
  sine wave. Hunger/satiety stays a slow bodily integrator fed by `fed` events.

Still modeled: the cursor-to-Poisson map, the background visual drive, the
rate-to-behavior scales, muscle forces. `src/brain.js` keeps the scripted
placeholder as the fallback when no pack is built (fresh clones, node tests);
`main.js` upgrades to the connectome brain once `data/` loads.

The **cord** (optional, `data-malecns/`): each fly also runs a second LIF
circuit over the MaleCNS v1.0 sensorimotor extract — 3,380 neurons including
all 708 leg motor neurons in flexor/extensor/rotator pools per thoracic
neuromere, the identified command cells, and bounded sets of descending and
ascending cells. The brain's DNa readouts drive the cord's DNa homologues
(lateralized by side, a modeled cross-specimen interface like DesktopFly's),
and the cord's motor-pool rates come back as per-leg tone that sets the walking
pace. The cord extract is deliberately tight: a first pass kept the whole
descending highway and seized at any real drive (measured, then fixed — see
`tools/fetch_malecns_pack.py`). The Shiu constants were fitted to FlyWire, not
to this male specimen, and the pack records that plainly.

The **anatomy** (committed, `data-flybody/`): the flies are the real FlyBody
meshes (TuragaLab/flybody, Apache-2.0) — thorax, head with compound eyes,
eight abdomen segments, folded wings with membranes and veins, and six
five-segment legs with claws, decimated and baked into the same rig frames the
procedural body used. `tools/fetch_flybody_pack.py` rebuilds them from the
original assets; `src/flybody.js` assembles the rig. A clone without the pack
falls back to the procedural anatomy, and the node tests keep using it.

The **Brain** button (preview only, key `B`) opens the live brain window:
the full CNS soma cloud (brain + ventral nerve cord) at real positions, the
watched fly's spikes flashing where they fire in both circuits, per-population
rates including cord tone, and a fly switcher.

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

`python3 tools/fetch_flywire_pack.py` builds the reduced circuit locally into
`scenes/flyscape/data/` (git-ignored): 961 neurons (escape, steering, grooming and
taste command populations plus their strongest partners), 17,952 signed synapses,
a 23,210-point soma cloud, and the Shiu et al. 2024 LIF constants in `meta.json`.
