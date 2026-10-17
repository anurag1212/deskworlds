import { clamp, randomGenerator, TAU } from "./math.js";

// The brain seam.
//
// Everything the flies decide is read from this module, and nothing in the world knows
// how a decision was made. The scaffold ships a *scripted placeholder*: rates are shaped
// by hand (a loom pulse, a slow arousal wave, hunger) and no connectome is involved.
//
// The connectome engine being prepared for v1 implements exactly this contract and
// replaces this file's `createBrain`:
//
//   * `update(dt, context)` runs the circuit for one step and returns one drive record
//     per body: { escape, arousal, steer, hungry }. The engine will drive these from
//     real neuron populations (LC4/LPLC2 -> DNp01 for escape, LC10a -> DNa01/DNa02 for
//     steering, sugar GRNs -> proboscis motor neurons for feeding), using the drained
//     readouts of a whole-brain or reduced-circuit LIF simulation.
//   * `notify(index, event)` is the body's feedback into the circuit ('fed', 'took-off',
//     'landed'), standing in for ascending and peripheral sensory neurons.
//   * `stats` reports what fired, for the scene's diagnostics.
//
// The placeholder keeps the same three pieces so the world, the tests and the seams do
// not move when the real engine lands. Its numbers are deliberately simple:
//
//   loom     an object approaching a fly fast raises `escape` to 1 and it decays back
//            over ~0.6 s; a cooldown stops one approach from firing every frame.
//   arousal  a slow wave per fly, lifted by hunger and dropped by recent flight, sets
//            how readily a fly takes off on its own.
//   hunger   grows with time; with sugar on the desk an hungry fly walks or flies to it.
//   steer    a slow wander bias the body may lean on when choosing a direction.

export const ESCAPE_THRESHOLD = 2.0;
export const ESCAPE_COOLDOWN = 2.4;
export const HUNGER_RATE = 0.016;

export function createBrain({ seed = 20261016 } = {}) {
  const random = randomGenerator(seed);
  const circuits = [];
  const stats = { escapes: 0, meals: 0, takeoffs: 0, landings: 0, loom: 0 };

  function circuit(index) {
    let state = circuits[index];
    if (!state) {
      state = {
        escape: 0,
        cooldown: 0,
        phase: random() * TAU,
        frequency: 0.02 + random() * 0.025,
        hunger: 0.08 + random() * 0.2,
        activity: 0,
      };
      circuits[index] = state;
    }
    return state;
  }

  function notify(index, event) {
    const state = circuit(index);
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

  // One step of the placeholder circuit. `context` carries:
  //   time    seconds since the world started
  //   pointer { position, velocity } in world units, or null while the cursor is away
  //   food    [{ position }] for every sugar piece the flies can smell
  //   bodies  [{ position }] one per fly, in fly order
  function update(dt, { time = 0, pointer = null, food = [], bodies = [] } = {}) {
    const drives = [];
    for (let index = 0; index < bodies.length; index++) {
      const state = circuit(index);
      const body = bodies[index];

      // Hunger and the slow arousal wave are free-running: they make an idle fly
      // restless eventually whether or not anything touches the desk. A fly that has
      // just landed carries a little arousal home with it.
      state.hunger = Math.min(1, state.hunger + dt * HUNGER_RATE);
      const wave = 0.5 + 0.5 * Math.sin(time * TAU * state.frequency + state.phase);
      let arousal =
        0.14 + wave * 0.3 + state.hunger * 0.26 + state.activity * 0.3;
      state.activity = Math.max(0, state.activity - dt * 0.05);

      // The loom: an object coming at a fly fast does not have to be close to matter.
      // Speed along the line to the fly over distance reads a quick approach as a
      // larger number than a close slow one, which is the shape a looming detector
      // has and the shape a cursor has when it darts across the desk.
      state.cooldown = Math.max(0, state.cooldown - dt);
      if (pointer && body) {
        const dx = body.position.x - pointer.position.x;
        const dy = body.position.y - pointer.position.y;
        const dz = body.position.z - pointer.position.z;
        const distance = Math.hypot(dx, dy, dz);
        const approach =
          pointer.velocity.x * dx + pointer.velocity.y * dy + pointer.velocity.z * dz;
        const loom = Math.max(0, approach) / Math.max(0.9, distance * distance);
        stats.loom = Math.max(stats.loom, loom);
        if (loom > ESCAPE_THRESHOLD && state.cooldown === 0 && state.escape < 0.5) {
          state.escape = 1;
          state.cooldown = ESCAPE_COOLDOWN;
          state.activity = clamp(state.activity + 0.4, 0, 1);
          stats.escapes++;
        }
      }
      state.escape *= Math.exp(-dt / 0.6);
      if (state.escape < 0.02) state.escape = 0;

      // Steering leans toward the nearest sugar when hungry; otherwise it is a slow
      // left-right wander the body samples when it has nothing better to do.
      let steer = Math.sin(time * 0.19 + state.phase * 2.1) * 0.6;
      if (food.length > 0 && body && state.hunger > 0.4) {
        let nearest = food[0];
        let best = Infinity;
        for (const piece of food) {
          const distance =
            (piece.position.x - body.position.x) ** 2 +
            (piece.position.z - body.position.z) ** 2;
          if (distance < best) {
            best = distance;
            nearest = piece;
          }
        }
        steer = clamp((nearest.position.x - body.position.x) * 0.5, -1, 1);
        arousal += 0.08;
      }

      drives.push({
        escape: state.escape,
        arousal: clamp(arousal, 0, 1),
        steer: clamp(steer, -1, 1),
        hungry: state.hunger > 0.4 && food.length > 0,
        hunger: state.hunger,
      });
    }
    return drives;
  }

  return {
    update,
    notify,
    stats,
    mode: "scripted-placeholder",
    note:
      "Hand-shaped drives. Connectome engine (LC4/LPLC2, LC10a->DNa01/02, sugar GRNs) " +
      "replaces this module behind the same update/notify contract.",
  };
}
