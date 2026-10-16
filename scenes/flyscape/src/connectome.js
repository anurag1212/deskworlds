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
// Brain-to-cord interface gain: brain DNa spikes/s become Poisson Hz on the
// MaleCNS DNa homologues. A modeling choice, stated here and in the README.
export const VNC_FOLLOW_GAIN = 4;
export const VNC_MAX_HZ = 120;

const LEG_NEUROMERES = { 0: "T1", 1: "T2", 2: "T3", 3: "T1" };

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
  const pack = {
    wiring: buildWiring(circuit.neurons, circuit.edges),
    neurons: circuit.neurons,
    cloud: cloud.points,
    cloudClasses: cloud.classes,
    model: meta.model,
  };
  // The MaleCNS sensorimotor pack is optional: fresh clones and the node tests
  // run the brain circuit alone.
  try {
    const dir = base.endsWith("data") ? `${base}-malecns` : `${base}/data-malecns`;
    const [vcircuit, vmeta] = await Promise.all(
      ["circuit.json", "meta.json"].map(async (file) => {
        const response = await fetch(`${dir}/${file}`);
        if (!response.ok) throw new Error(`vnc pack fetch failed: ${file}`);
        return response.json();
      }),
    );
    pack.vnc = {
      wiring: buildWiring(vcircuit.neurons, vcircuit.edges),
      neurons: vcircuit.neurons,
      model: vmeta.model,
    };
    // The cord pack's cloud spans brain AND ventral nerve cord, so it is the
    // better picture for the brain window once it exists.
    try {
      const response = await fetch(`${dir}/brain_points.json`);
      if (response.ok) {
        const vcloud = await response.json();
        pack.cloud = vcloud.points;
        pack.cloudClasses = vcloud.classes;
      }
    } catch {
      // Keep the brain-only cloud.
    }
  } catch (error) {
    console.warn("flyscape: no MaleCNS pack;", error.message);
  }
  return pack;
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
  // The cord circuit is optional (MaleCNS pack missing): the brain runs alone.
  const vwiring = pack.vnc?.wiring ?? null;
  const vparams = pack.vnc ? {
    v0: pack.vnc.model.v_0, vrst: pack.vnc.model.v_rst, vth: pack.vnc.model.v_th,
    tm: pack.vnc.model.t_mbr, tau: pack.vnc.model.tau,
    trfc: pack.vnc.model.t_rfc, tdly: pack.vnc.model.t_dly,
    wsyn: pack.vnc.model.w_syn, rPoi: pack.vnc.model.r_poi,
    fPoi: pack.vnc.model.f_poi, dt: pack.vnc.model.dt,
  } : null;
  const vsides = pack.vnc ? pack.vnc.neurons.map((neuron) => neuron.side) : [];
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
    const state = {
      circuit,
      hunger: 0.08 + (f * 0.05) % 0.2,
      activity: 0,
      escape: 0,
      cooldown: 0,
      steerOffset: 0,
      burst: 0, // smoothed loom spike count (150 ms window), for the escape readout
      // Dense drive buffers, reused every update: Map.get per neuron per tick
      // was the hot path; a Float64Array indexed directly is ~3x faster.
      drive: new Float64Array(wiring.n),
      driveList: [],
    };
    if (vwiring) {
      const vnc = createCircuit({
        n: vwiring.n,
        rowPtr: vwiring.rowPtr,
        col: vwiring.col,
        count: vwiring.count,
        params: vparams,
      });
      vnc.seedRandom(randomGenerator(seed + 100003 + f * 7919));
      state.vnc = vnc;
      state.vdrive = new Float64Array(vwiring.n);
      state.vdriveList = [];
      state.legs = [{}, {}, {}, {}].map(() => ({ flexHz: 0, extHz: 0, rotHz: 0 }));
    }
    circuits.push(state);
  }
  const stats = {
    escapes: 0, meals: 0, takeoffs: 0, landings: 0, loom: 0,
    spikes: 0, vncSpikes: 0, ticks: 0,
  };
  const groupSpikes = {}; // role -> spikes this update, for the brain view
  let lastRates = {}; // role -> Hz, for the brain view

  // Calibration: symmetric LC10a drive at the background operating point, measure
  // the DNa right-minus-left bias the wiring alone produces (the halves are not
  // mirror images, and the bias is rate-dependent: -3 Hz at 8 Hz background vs
  // -97 at 60 Hz), then subtract it from every steering readout. Same reason
  // doodle-fly calibrates.
  function calibrate() {
    const drive = new Float64Array(wiring.n);
    const list = [];
    for (const i of wiring.groups.lc10a ?? []) setDrive(drive, list, i, BACKGROUND_HZ);
    const ticks = Math.round(calibrateSeconds * TICKS_PER_SECOND);
    for (const state of circuits) {
      let right = 0, left = 0;
      const roles = wiring.roles;
      const sides = pack.neurons.map((neuron) => neuron.side);
      for (let t = 0; t < ticks; t++) {
        for (const s of state.circuit.step(drive, null, list)) {
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

  // Reusable drive helpers: zero only what was set last time, O(driven).
  function clearDrive(drive, list) {
    for (let k = 0; k < list.length; k++) drive[list[k]] = 0;
    list.length = 0;
  }
  function setDrive(drive, list, i, hz) {
    if (hz > 0) {
      if (drive[i] === 0) list.push(i);
      drive[i] = hz;
    }
  }

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
      clearDrive(state.drive, state.driveList);
      const drive = state.drive;
      const loomHz = Math.min(LOOM_MAX_HZ, loom * LOOM_GAIN);
      for (const i of wiring.groups.lc4 ?? []) setDrive(drive, state.driveList, i, loomHz);
      for (const i of wiring.groups.lplc2 ?? []) setDrive(drive, state.driveList, i, loomHz);
      const hungry = state.hunger > 0.4 && food.length > 0;
      if (hungry) for (const i of wiring.groups.sugar ?? []) setDrive(drive, state.driveList, i, SUGAR_HZ);
      const wander = BACKGROUND_HZ * (0.5 + 0.5 * Math.sin(time * 0.4 + index * TAU / circuits.length));
      for (const i of wiring.groups.lc10a ?? [])
        setDrive(drive, state.driveList, i, (drive[i] ?? 0) + wander);

      // Step, draining spikes into population readouts.
      let gf = 0, loomPop = 0, dnaR = 0, dnaL = 0, proboscis = 0, total = 0;
      const sides = pack.neurons.map((neuron) => neuron.side);
      const roles = wiring.roles;
      const recent = []; // neuron indices spiking this update, for the view
      for (let t = 0; t < ticks; t++) {
        for (const s of state.circuit.step(drive, null, state.driveList)) {
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
      const dnaRHz = dnaR / seconds, dnaLHz = dnaL / seconds;
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

      // The cord: brain descending readouts become Poisson drive on the MaleCNS
      // homologues (same identified cells, male specimen with the cord
      // attached), background arousal onto the descending highway, and the same
      // loom/taste context onto its detectors. Motor-pool rates come back out.
      // This is a modeled interface between two specimens, like DesktopFly's:
      // no invented cross-specimen synapses, just rate following.
      let legDrives = null, vncHz = 0;
      if (state.vnc && vwiring) {
        clearDrive(state.vdrive, state.vdriveList);
        const vdrive = state.vdrive;
        const vlist = state.vdriveList;
        const recentVnc = [];
        const followSide = (role, hzR, hzL) => {
          for (const i of vwiring.groups[role] ?? []) {
            const hz = vsides[i] === "left" ? hzL : hzR;
            setDrive(vdrive, vlist, i, Math.min(VNC_MAX_HZ, Math.max(0, hz)));
          }
        };
        followSide("dna01", dnaRHz * VNC_FOLLOW_GAIN, dnaLHz * VNC_FOLLOW_GAIN);
        followSide("dna02", dnaRHz * VNC_FOLLOW_GAIN, dnaLHz * VNC_FOLLOW_GAIN);
        for (const i of vwiring.groups.gf ?? [])
          setDrive(vdrive, vlist, i, state.escape > 0.5 ? 150 : 0);
        for (const i of vwiring.groups.dn ?? [])
          setDrive(vdrive, vlist, i, arousal * 3);
        for (const i of vwiring.groups.lc4 ?? []) setDrive(vdrive, vlist, i, loomHz);
        for (const i of vwiring.groups.lplc2 ?? []) setDrive(vdrive, vlist, i, loomHz);
        if (hungry) for (const i of vwiring.groups.sugar ?? []) setDrive(vdrive, vlist, i, SUGAR_HZ);
        const poolCounts = {};
        let vtotal = 0;
        for (let t = 0; t < ticks; t++) {
          for (const s of state.vnc.step(vdrive, null, vlist)) {
            vtotal++;
            if (recentVnc.length < 400) recentVnc.push(s);
            const role = vwiring.roles[s];
            if (role.startsWith("mn_")) poolCounts[role] = (poolCounts[role] ?? 0) + 1;
          }
        }
        state.recentVnc = recentVnc;
        stats.vncSpikes = (stats.vncSpikes ?? 0) + vtotal;
        vncHz = vtotal / seconds / vwiring.n;
        // Four walking legs read T1/T2/T3 pools (near/mid/far pair assignment
        // stays kinematic in fly.js; the pools report per-leg motor tone).
        // Tone is the mean per-cell rate of a pool, so a big pool is not
        // automatically louder than a small one.
        const poolHz = (role) =>
          (poolCounts[role] ?? 0) / seconds / Math.max(1, (vwiring.groups[role] ?? []).length);
        legDrives = [0, 1, 2, 3].map((leg) => {
          const nm = LEG_NEUROMERES[leg];
          return {
            flexHz: poolHz(`mn_${nm}_flex`) + poolHz(`mn_${nm}_other`) * 0.5,
            extHz: poolHz(`mn_${nm}_ext`) + poolHz(`mn_${nm}_other`) * 0.5,
            rotHz: poolHz(`mn_${nm}_rot`),
          };
        });
        state.legs = legDrives;
      }

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
        vncHz,
        legDrives, // per-leg {flexHz, extHz, rotHz} motor tone, or null without the cord
        // One number for the body: the mean motor-pool tone across all four legs.
        legTone: legDrives
          ? legDrives.reduce(
              (sum, leg) => sum + leg.flexHz + leg.extHz + leg.rotHz, 0,
            ) / legDrives.length
          : undefined,
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
    recentVnc: (index) => circuits[index]?.recentVnc ?? [],
    note: "Shiu 2024 LIF on the FlyWire v783 reduced circuit: loom bursts " +
      "LC4/LPLC2 to escape, sugar drives sugar GRNs, DNa01/02 R-L steers.",
  };
}
