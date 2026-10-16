// The connectome layer: real FlyWire wiring driving the brain seam's contract.
//
// One pack (circuit.json + meta.json from tools/fetch_flywire_pack.py), one LIF
// circuit per fly, all sharing the wiring but with independent state and input.
// Each update() step:
//   * converts the world's loom/food/pointer context into Poisson drive rates on
//     identified populations (LC4/LPLC2 for loom, sugar GRNs for taste, LC10a
//     background for visual wander),
//   * steps every fly's circuit, and
//   * drains identified readouts (LC4/LPLC2 burst, or a DNp01 giant-fiber
//     spike, -> escape; DNa01/DNa02 right-minus-left -> steer; proboscis MNs ->
//     feeding; population rate -> arousal) into the same drive records the
//     placeholder produces.
//
// What is modeled, stated plainly: the cursor-to-retina map (loom intensity to
// Poisson Hz), the background visual drive (without it an unstimulated brain is
// silent and no fly would ever take off on its own), the DNa calibration offset,
// and the rate-to-behavior scales. The wiring, signs and dynamics are measured.

import { createCircuit } from "./lif.js";
import { clamp, randomGenerator, TAU } from "./math.js";

export const TICKS_PER_SECOND = 10000; // dt = 0.1 ms
export const ESCAPE_DECAY = 0.6; // seconds, matches the placeholder
export const ESCAPE_COOLDOWN = 2.4;
export const HUNGER_RATE = 0.016; // satiety is bodily state, kept as an integrator

// Drive rates in Hz. The loom gain is set so a hand darting across the desk
// (~10 world-units/s at closest approach) drives LC4/LPLC2 near r_poi.
export const LOOM_GAIN = 14;
export const LOOM_MAX_HZ = 220;
// Escape reads the LC4/LPLC2 population burst, not the giant fiber alone: the
// reduced extract preserves the looming detectors but cuts the recurrent loops
// that fire GF in the full brain (GF's in-circuit in-weight sums net negative,
// and 46k loom spikes/s never fire it). Measured on this pack: a fast loom
// bursts ~150 Hz per detector cell, a slow hand ~5, silence 0. The threshold
// sits per-cell, in the open water between, so it scales to any extract size.
// A GF spike also escapes, for the full-brain future.
export const LOOM_BURST_PER_CELL_HZ = 25;
export const SUGAR_HZ = 100; // Shiu example notebook's taste drive
export const BACKGROUND_HZ = 8; // sparse visual wander on LC10a
export const STEER_GAIN = 0.05; // DNa rate difference (Hz) -> steer

// Build the shared wiring once: sorted CSR plus group index lists.
export function buildWiring(neurons, edges) {
  const n = neurons.length;
  const order = edges
    .map((_, i) => i)
    .sort((a, b) => edges[a][0] - edges[b][0] || edges[a][1] - edges[b][1]);
  const rowPtr = new Uint32Array(n + 1);
  const col = new Uint32Array(edges.length);
  const count = new Float64Array(edges.length);
  const roles = neurons.map((neuron) => neuron.role);
  const groups = {};
  for (let i = 0; i < n; i++) {
    const role = roles[i];
    (groups[role] ??= []).push(i);
  }
  for (let k = 0; k < order.length; k++) {
    const [pre, post, w] = edges[order[k]];
    col[k] = post;
    count[k] = w;
    rowPtr[pre + 1]++;
  }
  for (let i = 0; i < n; i++) rowPtr[i + 1] += rowPtr[i];
  return { n, rowPtr, col, count, groups, roles };
}

export async function loadPack(base = "data") {
  const [circuit, meta, cloud] = await Promise.all(
    ["circuit.json", "meta.json", "brain_points.json"].map(async (file) => {
      const response = await fetch(`${base}/${file}`);
      if (!response.ok) throw new Error(`pack fetch failed: ${file}`);
      return response.json();
    }),
  );
  return {
    wiring: buildWiring(circuit.neurons, circuit.edges),
    neurons: circuit.neurons,
    cloud: cloud.points,
    cloudClasses: cloud.classes,
    model: meta.model,
  };
}

function loomOf(pointer, position) {
  if (!pointer || !position) return 0;
  const dx = position.x - pointer.position.x;
  const dy = position.y - pointer.position.y;
  const dz = position.z - pointer.position.z;
  const distance = Math.hypot(dx, dy, dz);
  const approach =
    pointer.velocity.x * dx + pointer.velocity.y * dy + pointer.velocity.z * dz;
  return Math.max(0, approach) / Math.max(0.9, distance * distance);
}

export function createConnectomeBrain(
  pack,
  { seed = 20261016, flies = 4, calibrateSeconds = 0.5 } = {},
) {
  const { wiring, model } = pack;
  const params = {
    v0: model.v_0, vrst: model.v_rst, vth: model.v_th,
    tm: model.t_mbr, tau: model.tau, trfc: model.t_rfc,
    tdly: model.t_dly, wsyn: model.w_syn,
    rPoi: model.r_poi, fPoi: model.f_poi, dt: model.dt,
  };
  const circuits = [];
  for (let f = 0; f < flies; f++) {
    const circuit = createCircuit({
      n: wiring.n,
      rowPtr: wiring.rowPtr,
      col: wiring.col,
      count: wiring.count,
      params,
    });
    circuit.seedRandom(randomGenerator(seed + f * 7919));
    circuits.push({
      circuit,
      hunger: 0.08 + (f * 0.05) % 0.2,
      activity: 0,
      escape: 0,
      cooldown: 0,
      steerOffset: 0,
      burst: 0, // smoothed loom spike count (150 ms window), for the escape readout
    });
  }
  const stats = {
    escapes: 0, meals: 0, takeoffs: 0, landings: 0, loom: 0,
    spikes: 0, ticks: 0,
  };
  const groupSpikes = {}; // role -> spikes this update, for the brain view
  let lastRates = {}; // role -> Hz, for the brain view

  // Calibration: symmetric LC10a drive at the background operating point, measure
  // the DNa right-minus-left bias the wiring alone produces (the halves are not
  // mirror images, and the bias is rate-dependent: -3 Hz at 8 Hz background vs
  // -97 at 60 Hz), then subtract it from every steering readout. Same reason
  // doodle-fly calibrates.
  function calibrate() {
    const drive = new Map();
    for (const i of wiring.groups.lc10a ?? []) drive.set(i, BACKGROUND_HZ);
    const ticks = Math.round(calibrateSeconds * TICKS_PER_SECOND);
    for (const state of circuits) {
      let right = 0, left = 0;
      const roles = wiring.roles;
      const sides = pack.neurons.map((neuron) => neuron.side);
      for (let t = 0; t < ticks; t++) {
        for (const s of state.circuit.step(drive)) {
          if (roles[s] === "dna01" || roles[s] === "dna02") {
            if (sides[s] === "right") right++;
            else left++;
          }
        }
      }
      state.steerOffset = (right - left) / calibrateSeconds;
      state.circuit.reset();
    }
  }
  calibrate();

  function notify(index, event) {
    const state = circuits[index];
    if (!state) return;
    if (event === "fed") {
      state.hunger = 0.1;
      state.activity = clamp(state.activity - 0.15, 0, 1);
      stats.meals++;
    } else if (event === "took-off") {
      state.activity = clamp(state.activity + 0.28, 0, 1);
      stats.takeoffs++;
    } else if (event === "landed") {
      state.activity = clamp(state.activity + 0.1, 0, 1);
      stats.landings++;
    }
  }

  function update(dt, { time = 0, pointer = null, food = [], bodies = [] } = {}) {
    const ticks = Math.min(400, Math.max(1, Math.round(dt * TICKS_PER_SECOND)));
    const drives = [];
    for (const role of Object.keys(wiring.groups)) groupSpikes[role] = 0;
    for (let index = 0; index < circuits.length; index++) {
      const state = circuits[index];
      const body = bodies[index];
      state.hunger = Math.min(1, state.hunger + dt * HUNGER_RATE);
      const loom = loomOf(pointer, body?.position);
      if (index === 0) stats.loom = Math.max(stats.loom, loom);

      // Inputs: loom onto the looming detectors, taste onto sugar GRNs when a
      // hungry fly can smell food, and a sparse visual background so the brain
      // is never fully silent (an unstimulated Shiu brain does nothing).
      const drive = new Map();
      const loomHz = Math.min(LOOM_MAX_HZ, loom * LOOM_GAIN);
      for (const i of wiring.groups.lc4 ?? []) drive.set(i, loomHz);
      for (const i of wiring.groups.lplc2 ?? []) drive.set(i, loomHz);
      const hungry = state.hunger > 0.4 && food.length > 0;
      if (hungry) for (const i of wiring.groups.sugar ?? []) drive.set(i, SUGAR_HZ);
      const wander = BACKGROUND_HZ * (0.5 + 0.5 * Math.sin(time * 0.4 + index * TAU / circuits.length));
      for (const i of wiring.groups.lc10a ?? []) drive.set(i, (drive.get(i) ?? 0) + wander);

      // Step, draining spikes into population readouts.
      let gf = 0, loomPop = 0, dnaR = 0, dnaL = 0, proboscis = 0, total = 0;
      const sides = pack.neurons.map((neuron) => neuron.side);
      const roles = wiring.roles;
      const recent = []; // neuron indices spiking this update, for the view
      for (let t = 0; t < ticks; t++) {
        for (const s of state.circuit.step(drive)) {
          total++;
          groupSpikes[roles[s]] = (groupSpikes[roles[s]] ?? 0) + 1;
          if (recent.length < 400) recent.push(s);
          if (roles[s] === "gf") gf++;
          else if (roles[s] === "lc4" || roles[s] === "lplc2") loomPop++;
          else if (roles[s] === "dna01" || roles[s] === "dna02") {
            if (sides[s] === "right") dnaR++;
            else dnaL++;
          } else if (roles[s] === "proboscis_mn") proboscis++;
        }
      }
      stats.spikes += total;
      stats.ticks += ticks;
      state.recent = recent;

      // Escape: a giant-fiber spike, or the looming-detector burst crossing
      // threshold. The burst is smoothed over 150 ms first: a single update is
      // 17 ms of Poisson noise, not a rate. Same pulse shape as the placeholder.
      const seconds = ticks / TICKS_PER_SECOND;
      const loomCells = (wiring.groups.lc4?.length ?? 0) + (wiring.groups.lplc2?.length ?? 0);
      state.burst = state.burst * Math.exp(-dt / 0.15) + loomPop;
      const burstHz = state.burst / 0.15;
      state.cooldown = Math.max(0, state.cooldown - dt);
      if ((gf > 0 || burstHz > LOOM_BURST_PER_CELL_HZ * loomCells) && state.cooldown === 0 && state.escape < 0.5) {
        state.escape = 1;
        state.cooldown = ESCAPE_COOLDOWN;
        state.activity = clamp(state.activity + 0.4, 0, 1);
        stats.escapes++;
      }
      state.escape *= Math.exp(-dt / ESCAPE_DECAY);
      if (state.escape < 0.02) state.escape = 0;

      const steerRate = (dnaR - dnaL) / seconds - state.steerOffset;
      let steer = clamp(steerRate * STEER_GAIN, -1, 1);
      // Hungry flies bias toward the nearest sugar, read off the world the
      // same way the placeholder did: the nose knows where dinner is.
      if (hungry && body) {
        let best = Infinity, sx = 0;
        for (const piece of food) {
          const d = (piece.position.x - body.position.x) ** 2 +
            (piece.position.z - body.position.z) ** 2;
          if (d < best) { best = d; sx = piece.position.x; }
        }
        steer = clamp((sx - body.position.x) * 0.5, -1, 1);
      }
      const arousal = clamp(
        0.1 + (total / seconds / wiring.n) * 4 + state.hunger * 0.22 + state.activity * 0.3,
        0, 1,
      );
      state.activity = Math.max(0, state.activity - dt * 0.05);

      drives.push({
        escape: state.escape,
        arousal,
        steer,
        hungry,
        hunger: state.hunger,
        // Live readouts for the brain view and diagnostics.
        gfHz: gf / seconds,
        loomHz: burstHz,
        steerHz: steerRate,
        proboscisHz: proboscis / seconds,
        popHz: total / seconds / wiring.n,
      });
    }
    for (const [role, count] of Object.entries(groupSpikes))
      lastRates[role] = count / (ticks / TICKS_PER_SECOND);
    return drives;
  }

  return {
    update, notify, stats,
    mode: "connectome-lif",
    groups: Object.keys(wiring.groups),
    rates: lastRates,
    recent: (index) => circuits[index]?.recent ?? [],
    note: "Shiu 2024 LIF on the FlyWire v783 reduced circuit: loom bursts " +
      "LC4/LPLC2 to escape, sugar drives sugar GRNs, DNa01/02 R-L steers.",
  };
}
