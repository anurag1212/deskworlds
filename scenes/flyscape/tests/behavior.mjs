import { register } from "node:module";
import assert from "node:assert/strict";

register("./three-loader.mjs", import.meta.url);
const THREE = await import("three");
const { createBrain } = await import("../src/brain.js");
const { createEnvironment } = await import("../src/environment.js");
const { createFlies } = await import("../src/fly.js");
const { createFood } = await import("../src/food.js");
const { renderSettings } = await import("../src/render-policy.js");
const { frameRate } = await import("../../shared/render-policy.js");

const STEP = 1 / 60;

// A whole world in the shape main.js builds it, minus the renderer.
function stage({ seed = 43107, brainSeed = 20261016 } = {}) {
  const scene = new THREE.Scene();
  const environment = createEnvironment(scene);
  const food = createFood(scene, { supportHeight: environment.supportHeight });
  const brain = createBrain({ seed: brainSeed });
  const flock = createFlies(scene, {
    obstacles: environment.obstacles,
    landmarks: environment.landmarks,
    bounds: environment.bounds,
    supportHeight: environment.supportHeight,
    surfaceAt: environment.surfaceAt,
    seed,
  });
  const bodies = flock.flies.map((fly) => ({ position: fly.group.position }));
  let time = 0;
  function run(seconds, { pointer = null, onFrame = null } = {}) {
    const steps = Math.round(seconds / STEP);
    for (let i = 0; i < steps; i++) {
      time += STEP;
      const drives = brain.update(STEP, {
        time,
        pointer,
        food: food.available(),
        bodies,
      });
      flock.update(STEP, time, { drives, food, pointer, onEvent: (fly, event) => brain.notify(fly.id, event) });
      food.update(STEP);
      onFrame?.(i);
    }
  }
  return { scene, environment, food, brain, flock, bodies, run, get time() { return time; } };
}

// The seam's contract: one bounded drive per body, every step.
{
  const brain = createBrain({ seed: 7 });
  const drives = brain.update(STEP, { time: 0, bodies: [{ position: { x: 0, y: 0, z: 0 } }] });
  assert.equal(drives.length, 1, "one drive record per body");
  for (const key of ["escape", "arousal", "steer"])
    assert(Number.isFinite(drives[0][key]) && drives[0][key] >= 0 && drives[0][key] <= 1,
      `drive ${key} must stay in [0, 1]`);
  assert.equal(typeof drives[0].hungry, "boolean");
}

// A loom fires once, decays, and cannot refire until its cooldown has passed.
{
  const brain = createBrain({ seed: 9 });
  const bodies = [{ position: { x: 0, y: 0, z: 0 } }];
  const lunge = {
    position: { x: 0, y: 0, z: 3 },
    velocity: { x: 0, y: 0, z: -10 },
  };
  let escape = 0;
  for (let i = 0; i < 30; i++) {
    const drives = brain.update(STEP, { time: i * STEP, pointer: lunge, bodies });
    escape = Math.max(escape, drives[0].escape);
  }
  assert.equal(brain.stats.escapes, 1, "a fast lunge fires the escape once");
  assert(escape > 0.5, "the escape drive spikes above the body's threshold");
  // The hand stops where it is: the pulse decays under 0.2 within 1.2 s.
  for (let i = 0; i < 72; i++) brain.update(STEP, { time: (30 + i) * STEP, bodies });
  const quiet = brain.update(STEP, { time: 2 * STEP * 100, bodies });
  assert(quiet[0].escape < 0.2, "the escape decays once the hand is still");
  // The same hand, still coming, cannot retrigger inside the cooldown but can after it.
  // The pulse fired at t=0 with a 2.4 s cooldown; 0.5 + 1.2 + 1/60 s have already run.
  for (let i = 0; i < 30; i++) {
    const drives = brain.update(STEP, { time: 0, pointer: lunge, bodies });
    assert(drives[0].escape <= 0.5, "the refire must wait for the cooldown");
  }
  assert.equal(brain.stats.escapes, 1, "one approach must not fire every frame");
  for (let i = 0; i < 60; i++) brain.update(STEP, { time: 0, pointer: lunge, bodies });
  assert(brain.stats.escapes >= 2, "a loom still arriving fires again after the cooldown");
}

// A slow hand is watched, not fled from.
{
  const brain = createBrain({ seed: 21 });
  const bodies = [{ position: { x: 0, y: 0, z: 0 } }];
  const drift = {
    position: { x: 0, y: 0, z: 3.5 },
    velocity: { x: 0, y: 0, z: -1.2 },
  };
  for (let i = 0; i < 180; i++) brain.update(STEP, { time: i * STEP, pointer: drift, bodies });
  assert.equal(brain.stats.escapes, 0, "a slow approach must not fire an escape");
}

// Ninety seconds of desk life: everyone stays in the room, walks, rests, and flies
// between the furniture without being scared by anything.
{
  const world = stage();
  const modes = new Set();
  const KNOWN = new Set(["rest", "groom", "walk", "takeoff", "fly", "land", "eat", "flee"]);
  const bounds = world.environment.bounds;
  world.run(90, {
    onFrame: () => {
      for (const fly of world.flock.flies) {
        modes.add(fly.mode);
        const p = fly.group.position;
        assert(
          p.toArray().every(Number.isFinite),
          "a fly must never leave the world through the arithmetic",
        );
        assert(KNOWN.has(fly.mode), `a fly is in a known state (got ${fly.mode})`);
        assert(p.x >= bounds.minX - 0.05 && p.x <= bounds.maxX + 0.05, "flies stay on the desk");
        assert(p.z >= bounds.minZ - 0.05 && p.z <= bounds.maxZ + 0.05, "flies stay on the desk");
        assert(p.y >= bounds.minY - 0.02 && p.y <= bounds.maxY + 0.01, "flies stay in the room");
      }
    },
  });
  assert(!modes.has("flee"), "an undisturbed desk never startles");
  assert(world.flock.stats.walks > 4, "flies walk");
  assert(world.flock.stats.takeoffs > 0, "flies take off on their own");
  assert(world.flock.stats.flights > 0, "flies fly between the furniture");
  assert(world.flock.stats.grooms > 0, "flies groom");
}

// The same seeds render the same world: positions agree to a millimetre after 30 s.
{
  const a = stage();
  const b = stage();
  a.run(30);
  b.run(30);
  for (let i = 0; i < a.flock.flies.length; i++) {
    const pa = a.flock.flies[i].group.position;
    const pb = b.flock.flies[i].group.position;
    assert(pa.distanceTo(pb) < 1e-3, `fly ${i} must be deterministic for a fixed seed`);
  }
}

// A fast hand over a fly: one or more scramble, then everyone settles again.
{
  const world = stage();
  world.run(20);
  const subject = world.flock.flies[0].group.position;
  const pointer = {
    position: new THREE.Vector3(subject.x + 2.2, subject.y + 0.6, subject.z + 2.2),
    velocity: new THREE.Vector3(),
  };
  const toward = new THREE.Vector3(
    subject.x - pointer.position.x,
    subject.y - pointer.position.y,
    subject.z - pointer.position.z,
  ).normalize().multiplyScalar(10);
  pointer.velocity.copy(toward);
  let scrambled = false;
  world.run(0.6, { pointer, onFrame: () => {
    scrambled ||= world.flock.flies.some((fly) => fly.mode === "flee");
  } });
  assert(world.brain.stats.escapes >= 1, "a fast hand on a fly fires the circuit");
  assert(scrambled || world.flock.stats.flees >= 1, "a scrambled fly is in the air");
  let settling = false;
  world.run(12, { onFrame: (i) => {
    if (i > 9 * 60) settling ||= world.flock.flies.some((fly) => fly.mode === "flee");
  } });
  assert(!settling, "the desk is calm again ten seconds after the hand leaves");
}

// Sugar on the desk: a hungry fly finds it, eats, and the cube is gone.
{
  const world = stage();
  world.run(40);
  const hungry = world.flock.flies[1].group.position;
  const cube = world.food.drop({ x: hungry.x + 0.9, y: 0, z: hungry.z + 0.9 });
  assert.equal(world.food.available().length, 0, "sugar is not scented until it lands");
  let ate = false;
  world.run(60, { onFrame: () => {
    ate ||= world.flock.flies.some((fly) => fly.mode === "eat");
  } });
  assert(ate, "a fly walks or flies to the sugar and feeds");
  assert(world.flock.stats.meals >= 1, "a cube is finished");
  assert(cube.plane === "gone", "the eaten cube leaves the desk");
  assert(world.food.stats.eaten >= 1, "the food book-keeping agrees");
}

// An untouched cube melts away on its own, and a nearby one is what `nearest` finds.
// No flies here: sugar left alone must not need a waker.
{
  const scene = new THREE.Scene();
  const environment = createEnvironment(scene);
  const food = createFood(scene, { supportHeight: environment.supportHeight });
  const near = food.drop({ x: 1, y: 0, z: 1 });
  food.drop({ x: 9, y: 0, z: 4 });
  for (let i = 0; i < 3 * 60; i++) food.update(STEP); // let both land
  const found = food.nearest({ x: 0, y: 0, z: 0 });
  assert.equal(found.id, near.id, "the nearest resting cube wins");
  for (let i = 0; i < 45 * 60; i++) food.update(STEP);
  assert(food.stats.dissolved >= 2, "untouched sugar dissolves on its own");
  assert.equal(food.available().length, 0, "nothing is left to smell");
}

// Presentation caps follow the shared table whatever the scene builds.
{
  assert.equal(frameRate("eco", 60, false), 20);
  assert.equal(frameRate("balanced", 60, false), 30);
  assert.equal(frameRate("detail", 60, false), 60);
  assert.equal(frameRate("detail", 60, true), 30, "on battery the wallpaper halves its rate");
  const settings = renderSettings({ profile: "balanced", wallpaper: true, pixelRatio: 2 });
  assert.equal(settings.samples, 4);
  assert(settings.resolution > 0 && Number.isFinite(settings.shadowSize));
  assert.equal(settings.shadowHz, Infinity, "this room redraws its shadows every frame");
}

console.log(
  "PASS: brain contract, loom pulses and cooldown, slow approach, desk life, determinism, startle and settle, feeding, sugar dissolve and nearest, presentation caps",
);
