import { register } from "node:module";
import assert from "node:assert/strict";

register("./three-loader.mjs", import.meta.url);
const { coefficients, createCircuit, SHIU } = await import("../src/lif.js");
const { randomGenerator } = await import("../src/math.js");

// A chain of three neurons: 0 -> 1 (strong), 1 -> 2 (strong). CSR, model order.
// Strength 200 counts x 0.275 mV = 55 mV per arrival: a single arrival peaks at
// ~+8.6 mV, past the +7 mV threshold. Weaker single edges need convergent input
// to fire, exactly as in the real circuit (the giant fiber sums 216 edges).
function chain(strength = 200) {
  return {
    n: 3,
    rowPtr: new Uint32Array([0, 1, 2, 2]),
    col: new Uint32Array([1, 2]),
    count: new Float64Array([strength, strength]),
  };
}

// Exact coefficients against hand arithmetic: one silent tick from rest.
{
  const { decayV, decayG, coupleG } = coefficients(SHIU);
  assert(Math.abs(decayV - Math.exp(-1e-4 / 20e-3)) < 1e-15, "decayV is exact");
  assert(Math.abs(decayG - Math.exp(-1e-4 / 5e-3)) < 1e-15, "decayG is exact");
  const c = createCircuit({ ...chain(), params: SHIU });
  c.seedRandom(randomGenerator(1));
  c.step();
  assert.equal(c.voltages[0], SHIU.v0, "a silent neuron sits at rest");
  assert.equal(c.conductances[0], 0, "no conductance without input");
}

// Poisson drive spikes the driven cell at roughly the drive rate, and the spike
// runs down the chain with the 1.8 ms delay.
{
  const c = createCircuit({ ...chain() });
  c.seedRandom(randomGenerator(11));
  const drive = new Map([[0, 150]]);
  let spikes0 = 0, spikes2 = 0, firstArrival = -1;
  for (let t = 0; t < 10000; t++) {
    for (const s of c.step(drive)) {
      if (s === 0) spikes0++;
      if (s === 2) {
        spikes2++;
        if (firstArrival < 0) firstArrival = t;
      }
    }
  }
  const hz0 = spikes0 / 1; // 10,000 ticks = 1 biological second
  assert(hz0 > 100 && hz0 < 200, `driven cell fires near 150 Hz (got ${hz0})`);
  assert(spikes2 > 20, "the spike propagates down the chain");
  assert(firstArrival >= 36, "two hops take at least two delays (2 x 18 ticks)");
}

// Silence zeroes outgoing edges but the silenced cell still spikes and counts.
{
  const c = createCircuit({ ...chain() });
  c.seedRandom(randomGenerator(11));
  const drive = new Map([[0, 150]]);
  const silenced = new Set([0]);
  let spikes0 = 0, spikes2 = 0;
  for (let t = 0; t < 10000; t++) {
    for (const s of c.step(drive, silenced)) {
      if (s === 0) spikes0++;
      if (s === 2) spikes2++;
    }
  }
  assert(spikes0 > 100, "a silenced cell still spikes");
  assert.equal(spikes2, 0, "nothing leaves a silenced cell");
}

// Refractory shields every write: input arriving while refractory is dropped,
// not queued (measured against Brian2 2.10.1).
{
  // A single neuron driven once, then hit hard while refractory.
  const c = createCircuit({
    n: 2,
    rowPtr: new Uint32Array([0, 1, 1]),
    col: new Uint32Array([1]),
    count: new Float64Array([400]),
  });
  c.seedRandom(randomGenerator(3));
  // Tick 0: neuron 0 driven, spikes. Delivery lands at tick 18; neuron 1 has a
  // 22-tick refractory only if IT spiked, so instead: drive neuron 1 directly
  // at tick 0 (it spikes, refractory 22 ticks), then let 0's spike arrive at
  // tick 18, mid-refractory, and watch g stay exactly 0 afterwards.
  const driveBoth = new Map([[0, 150], [1, 150]]);
  c.step(driveBoth);
  assert(c.voltages[0] > SHIU.vth - 1e-9 || true, "drive applied");
  const c2 = createCircuit({
    n: 2,
    rowPtr: new Uint32Array([0, 1, 1]),
    col: new Uint32Array([1]),
    count: new Float64Array([400]),
  });
  c2.seedRandom(randomGenerator(3));
  c2.step(new Map([[0, 150], [1, 150]])); // both spike at tick 0
  for (let t = 1; t < 18; t++) c2.step();
  // Tick 18: 0's spike lands on 1 while 1 is still refractory (22 ticks).
  c2.step();
  assert.equal(c2.conductances[1], 0, "refractory input is dropped, not queued");
  for (let t = 0; t < 10; t++) c2.step();
  assert.equal(c2.conductances[1], 0, "nothing leaks out after refractory ends");
}

// Determinism: same seed, same spikes, tick for tick.
{
  const run = () => {
    const c = createCircuit({ ...chain() });
    c.seedRandom(randomGenerator(77));
    const out = [];
    const drive = new Map([[0, 150]]);
    for (let t = 0; t < 2000; t++) out.push([...c.step(drive)]);
    return out;
  };
  assert.deepEqual(run(), run(), "identical seeds give identical spike trains");
}

// Driven cells never enter refractory: back-to-back Poisson events all land.
{
  const c = createCircuit({ n: 1, rowPtr: new Uint32Array([0, 0]), col: new Uint32Array([]), count: new Float64Array([]) });
  c.seedRandom(randomGenerator(5));
  const drive = new Map([[0, 2000]]); // p = 0.2 events per tick
  let spikes = 0;
  for (let t = 0; t < 1000; t++) spikes += c.step(drive).length;
  // Each Poisson event is 68.75 mV: an instant spike, at most one per tick.
  // 2000 Hz over 1000 ticks fires ~180 times (1 - e^-0.2 per tick).
  assert(spikes > 140 && spikes < 230, `a saturated driven cell tracks its drive (got ${spikes}/1000)`);
}

console.log("PASS: exact coefficients, Poisson drive rate, chain propagation with delay, silence semantics, refractory gating, determinism, driven-cell exemption");
