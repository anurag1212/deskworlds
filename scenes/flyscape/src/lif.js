// Leaky integrate-and-fire core: Shiu et al. 2024, exact linear update.
//
// The whole-brain model from philshiu/Drosophila_brain_model (MIT), reduced to a
// pure step function with no DOM, no worker API and no allocation inside the tick
// loop, so node tests and the browser engine share it bit for bit.
//
// Semantics mirror model.py:create_model() exactly:
//   * exact closed-form update of v and g per tick (Brian2 method='linear')
//   * strict v > v_th threshold, reset v = v_rst, g = 0
//   * 2.2 ms refractory shields a neuron from *every* write, synaptic input
//     included (measured against Brian2 2.10.1; see drosophila-brain-mlx)
//   * Poisson-driven neurons never enter refractory (Shiu poi(): rfc = 0)
//   * spikes arrive after a 1.8 ms delay through a ring buffer
//   * synaptic arrivals accumulate as integer contact counts; the 0.275 mV
//     factor applies once, afterwards (integer addition is order-independent)
//   * silence() zeroes every synapse *from* a neuron; it still spikes and counts
//
// Units are SI (volts, seconds, hertz) like meta.json. Indices are model order:
// row i of the pack's neuron list, NOT FlyWire root IDs.

export const SHIU = Object.freeze({
  v0: -52e-3, // resting potential
  vrst: -52e-3, // reset potential after spike
  vth: -45e-3, // spike threshold
  tm: 20e-3, // membrane time scale
  tau: 5e-3, // synaptic time constant
  trfc: 2.2e-3, // refractory period
  tdly: 1.8e-3, // post-synaptic delay
  wsyn: 0.275e-3, // weight per synapse
  rPoi: 150, // default Poisson drive rate (Hz)
  fPoi: 250, // Poisson weight scale (68.75 mV per event: always spikes)
  dt: 0.1e-3, // tick
});

// Exact per-tick coefficients for the linear system, derived once:
//   g(t+dt) = g(t) * decayG
//   v(t+dt) = v0 + (v(t) - v0) * decayV + g(t) * coupleG
export function coefficients(p = SHIU) {
  const decayV = Math.exp(-p.dt / p.tm);
  const decayG = Math.exp(-p.dt / p.tau);
  const coupleG = (decayV - decayG) / (p.tm * (1 / p.tau - 1 / p.tm));
  return { decayV, decayG, coupleG };
}

export function createCircuit({ n, rowPtr, col, count, params = SHIU } = {}) {
  const { decayV, decayG, coupleG } = coefficients(params);
  const v = new Float64Array(n).fill(params.v0);
  const g = new Float64Array(n);
  const refractory = new Int32Array(n); // ticks remaining; driven cells stay 0
  const delayTicks = Math.max(1, Math.round(params.tdly / params.dt));
  const rfcTicks = Math.round(params.trfc / params.dt);
  // Delay ring: bucket[t] holds [post, contactCount] pairs landing on tick t.
  const ring = [];
  for (let i = 0; i < delayTicks; i++) ring.push([]);
  let cursor = 0;
  let tick = 0;
  // Activity tracking: a neuron at rest (v == v0, g == 0, no refractory, no
  // arrivals) is an exact fixed point of the update, so it is skipped until
  // something touches it. Dense list + position map for O(1) add/remove.
  const activeList = [];
  const activePos = new Int32Array(n).fill(-1);

  function activate(i) {
    if (activePos[i] < 0) {
      activePos[i] = activeList.length;
      activeList.push(i);
    }
  }

  function deactivateAt(k) {
    const last = activeList.pop();
    if (k < activeList.length) {
      activeList[k] = last;
      activePos[last] = k;
    }
    // activePos[removed] reset by caller
  }
  const spikes = []; // reused scratch, returned by reference: copy it out
  const incoming = new Float64Array(n); // arrivals this tick, as raw counts

  // One 0.1 ms tick. `drive` is either a Float64Array of per-neuron Poisson
  // rates in Hz, or a Map index->rate; `silenced` is a Set of indices whose
  // outgoing edges deliver nothing; `driveList` (with an array drive) lists the
  // nonzero entries so activation stays O(driven), not O(n).
  // Returns the shared scratch array of spiking indices (copy before keeping).
  function step(drive = null, silenced = null, driveList = null) {
    spikes.length = 0;
    const isMap = drive instanceof Map;
    const landing = ring[cursor];
    ring[cursor] = [];
    cursor = (cursor + 1) % delayTicks;
    // Deliveries accumulate as integer counts first; the millivolt factor
    // applies once below, so the sum cannot depend on arrival order.
    // A delivery wakes its target: it now has something to integrate.
    for (let k = 0; k < landing.length; k++) {
      const [post, count] = landing[k];
      if (refractory[post] === 0) {
        incoming[post] += count;
        activate(post);
      }
    }
    // Driven cells are awake by definition while their rate is set.
    if (drive) {
      if (isMap) {
        for (const i of drive.keys()) if (drive.get(i)) activate(i);
      } else if (driveList) {
        for (let k = 0; k < driveList.length; k++)
          if (drive[driveList[k]]) activate(driveList[k]);
      } else {
        for (let i = 0; i < n; i++) if (drive[i]) activate(i);
      }
    }
    const v0 = params.v0, vth = params.vth, vrst = params.vrst;
    const wsyn = params.wsyn, poissonStep = wsyn * params.fPoi;
    // Only awake neurons are stepped; the rest sit exactly at rest. The loop
    // compacts as neurons settle, so a quiet network costs almost nothing.
    // Newly woken neurons append during iteration and are stepped the same tick.
    for (let k = 0; k < activeList.length; k++) {
      const i = activeList[k];
      if (refractory[i] > 0) {
        // Shielded from every write while refractory, then released.
        // The arrival counts above were already gated; nothing else to do.
        refractory[i]--;
        continue;
      }
      let vi = v0 + (v[i] - v0) * decayV + g[i] * coupleG;
      let gi = g[i] * decayG;
      const arrived = incoming[i];
      if (arrived !== 0) {
        gi += arrived * wsyn;
        incoming[i] = 0;
      }
      const rate = drive ? (isMap ? drive.get(i) : drive[i]) : 0;
      if (rate) {
        // Poisson events add straight into voltage, as in Shiu poi().
        // Knuth sampling: exact for any rate, 1-2 RNG draws at these rates.
        const p = rate * params.dt;
        let events = 0, prob = 1;
        const limit = Math.exp(-p);
        do { events++; prob *= rng(); } while (prob > limit);
        vi += (events - 1) * poissonStep;
        v[i] = vi;
        g[i] = gi;
        if (vi > vth) {
          spikes.push(i);
          v[i] = vrst;
          g[i] = 0;
          // No refractory for driven cells: Shiu sets rfc = 0 on Poisson targets.
        }
        continue;
      }
      v[i] = vi;
      g[i] = gi;
      if (vi > vth) {
        spikes.push(i);
        v[i] = vrst;
        g[i] = 0;
        refractory[i] = rfcTicks;
        continue;
      }
      // Settled back to exact rest with nothing pending: sleep until touched.
      if (vi === v0 && gi === 0) {
        activePos[i] = -1;
        deactivateAt(k);
        k--;
      }
    }
    // Schedule this tick's spikes onto the ring, unless silenced.
    const slot = (cursor + delayTicks - 1) % delayTicks;
    for (let s = 0; s < spikes.length; s++) {
      const pre = spikes[s];
      if (silenced && silenced.has(pre)) continue;
      for (let e = rowPtr[pre]; e < rowPtr[pre + 1]; e++)
        ring[slot].push([col[e], count[e]]);
    }
    tick++;
    return spikes;
  }

  // Seeded uniform RNG is injected so node tests and the scene stay deterministic.
  let rng = Math.random;
  function seedRandom(fn) {
    rng = fn;
  }

  function reset() {
    v.fill(params.v0);
    g.fill(0);
    refractory.fill(0);
    incoming.fill(0);
    activeList.length = 0;
    activePos.fill(-1);
    for (let i = 0; i < ring.length; i++) ring[i] = [];
    cursor = 0;
    tick = 0;
  }

  return {
    step, reset, seedRandom,
    get tick() { return tick; },
    voltages: v,
    conductances: g,
  };
}
