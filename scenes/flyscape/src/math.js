import * as THREE from "three";

import { randomGenerator } from "../../shared/random.js";
export { randomGenerator };

// Scene-local stream: everything that decides something without an input sits on its own
// seeded generator, so two runs of the same world agree frame for frame.
export const random = randomGenerator(904201);
export const range = (a, b) => a + (b - a) * random();
export const vec = (x, y, z) => new THREE.Vector3(x, y, z);

export const TAU = Math.PI * 2;

export function clamp(x, min, max) {
  return Math.min(max, Math.max(min, x));
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Frame-rate independent exponential approach, the same shape three's MathUtils.damp
// has: `lambda` is the rate at which half the remaining distance closes.
export function damp(current, target, lambda, dt) {
  return THREE.MathUtils.damp(current, target, lambda, dt);
}

// Shortest signed difference between two angles, in (-PI, PI].
export function angleDelta(from, to) {
  let delta = (to - from) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta <= -Math.PI) delta += TAU;
  return delta;
}
