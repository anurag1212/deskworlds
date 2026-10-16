import { register } from "node:module";
import assert from "node:assert/strict";

register("./three-loader.mjs", import.meta.url);
const { buildWiring, createConnectomeBrain } = await import("../src/connectome.js");
const { randomGenerator } = await import("../src/math.js");

// A micro-pack with the same shape as circuit.json: every role the mapping
// reads, wired strongly enough that single edges fire their targets — except
// the loom path, which converges three LC4 cells onto the giant fiber the way
// the real circuit does (216 edges). Convergence is what separates a fast loom
// (coincident arrivals) from a slow one (lonely arrivals).
function microPack() {
  // 0,1,2:lc4 -> 3:gf | 4:sugar -> 5:proboscis_mn | 6:lc10a -> 7:dna02_R, 8:dna02_L
  const neurons = [
    { id: "a", type: "LC4", role: "lc4", side: "right", pos: [0, 0, 0] },
    { id: "b", type: "LC4", role: "lc4", side: "left", pos: [0, 0, 0] },
    { id: "c", type: "LC4", role: "lc4", side: "right", pos: [0, 0, 0] },
    { id: "d", type: "DNp01", role: "gf", side: "center", pos: [0, 0, 0] },
    { id: "e", type: "sugar", role: "sugar", side: "right", pos: [0, 0, 0] },
    { id: "f", type: "MN", role: "proboscis_mn", side: "center", pos: [0, 0, 0] },
    { id: "g", type: "LC10a", role: "lc10a", side: "right", pos: [0, 0, 0] },
    { id: "h", type: "DNa02", role: "dna02", side: "right", pos: [0, 0, 0] },
    { id: "i", type: "DNa02", role: "dna02", side: "left", pos: [0, 0, 0] },
  ];
  const edges = [
    [0, 3, 40], [1, 3, 40], [2, 3, 40],
    [4, 5, 200], [6, 7, 200], [6, 8, 200],
  ];
  return {
    wiring: buildWiring(neurons, edges),
    neurons,
    cloud: [],
    cloudClasses: [],
    model: {
      v_0: -52e-3, v_rst: -52e-3, v_th: -45e-3, t_mbr: 20e-3, tau: 5e-3,
      t_rfc: 2.2e-3, t_dly: 1.8e-3, w_syn: 0.275e-3,
      r_poi: 150, f_poi: 250, dt: 0.1e-3,
    },
  };
}

const STEP = 1 / 60;
const bodies = [{ position: { x: 0, y: 0, z: 0 } }];

// The seam's contract: one bounded drive record per circuit, every step.
{
  const brain = createConnectomeBrain(microPack(), { flies: 2, calibrateSeconds: 0.05 });
  assert.equal(brain.mode, "connectome-lif");
  const drives = brain.update(STEP, { time: 0, bodies: [{}, {}] });
  assert.equal(drives.length, 2, "one drive record per fly");
  for (const key of ["escape", "arousal", "steer"])
    assert(Number.isFinite(drives[0][key]) && drives[0][key] >= 0 && drives[0][key] <= 1,
      `drive ${key} stays in [0, 1]`);
  assert.equal(typeof drives[0].hungry, "boolean");
  assert(drives[0].gfHz >= 0 && drives[0].popHz >= 0, "live readouts present");
}

// A loom drives LC4, LC4 fires the giant fiber, the escape pulses and decays.
{
  const brain = createConnectomeBrain(microPack(), { flies: 1, calibrateSeconds: 0.05 });
  const lunge = {
    position: { x: 0, y: 0, z: 3 },
    velocity: { x: 0, y: 0, z: -10 },
  };
  let peak = 0;
  for (let i = 0; i < 30; i++) {
    const [drive] = brain.update(STEP, { time: i * STEP, pointer: lunge, bodies });
    peak = Math.max(peak, drive.escape);
  }
  assert.equal(brain.stats.escapes, 1, "a fast lunge fires the giant fiber once");
  assert(peak > 0.5, "the escape drive spikes above the body's threshold");
  for (let i = 0; i < 120; i++) brain.update(STEP, { time: i * STEP, bodies });
  const [quiet] = brain.update(STEP, { time: 0, bodies });
  assert(quiet.escape < 0.2, "the escape decays once the hand is still");
}

// A slow hand is watched, not fled from.
{
  const brain = createConnectomeBrain(microPack(), { flies: 1, calibrateSeconds: 0.05 });
  const drift = {
    position: { x: 0, y: 0, z: 3.5 },
    velocity: { x: 0, y: 0, z: -0.4 },
  };
  for (let i = 0; i < 180; i++) brain.update(STEP, { time: i * STEP, pointer: drift, bodies });
  assert.equal(brain.stats.escapes, 0, "a slow approach must not fire an escape");
}

// Sugar on the desk drives the taste circuit when the fly is hungry.
{
  const brain = createConnectomeBrain(microPack(), { flies: 1, calibrateSeconds: 0.02 });
  const food = [{ position: { x: 1, y: 0, z: 1 } }];
  // Starve it first: 60 s with no food.
  for (let i = 0; i < 3600; i += 10)
    brain.update(STEP * 10, { time: i * STEP, bodies });
  let proboscis = 0;
  for (let i = 0; i < 60; i++) {
    const [drive] = brain.update(STEP, { time: i * STEP, food, bodies });
    proboscis = Math.max(proboscis, drive.proboscisHz);
    if (i === 0) assert(drive.hungry, "a starved fly with food is hungry");
  }
  assert(proboscis > 1, `sugar drives the proboscis readout (got ${proboscis} Hz)`);
  brain.notify(0, "fed");
  const [full] = brain.update(STEP, { time: 0, food, bodies });
  assert(!full.hungry, "a fed fly is not hungry");
}

// Determinism: same seed, same escapes.
{
  const run = () => {
    const brain = createConnectomeBrain(microPack(), { seed: 99, flies: 1, calibrateSeconds: 0.05 });
    const lunge = {
      position: { x: 0, y: 0, z: 3 },
      velocity: { x: 0, y: 0, z: -10 },
    };
    const escapes = [];
    for (let i = 0; i < 120; i++)
      escapes.push(brain.update(STEP, { time: i * STEP, pointer: lunge, bodies })[0].escape);
    return escapes;
  };
  assert.deepEqual(run(), run(), "identical seeds give identical escapes");
}

console.log("PASS: seam contract, loom escape with decay, slow approach, taste drive with satiety, determinism");
